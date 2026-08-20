import { type Context, createFauxProvider, type Message, type Provider, Type } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool, type ToolExecutionMiddleware } from "../src/index.ts";

const echoParameters = Type.Object({ value: Type.String() });

function toolResult(messages: readonly Message[], toolCallId: string) {
	const result = messages.find((message) => message.role === "tool_result" && message.toolCallId === toolCallId);
	if (!result || result.role !== "tool_result") {
		throw new Error(`Missing tool result for ${toolCallId}`);
	}
	return result;
}

describe("tool loop", () => {
	it("resolves a fresh request context and applies middleware around execution", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "tool_call", id: "dynamic-1", name: "dynamic", arguments: {} }] },
				{ type: "success", content: [{ type: "text", text: "done" }] },
			],
		});
		const dynamicParameters = Type.Object({});
		const tool = {
			name: "dynamic",
			description: "dynamic",
			parameters: dynamicParameters,
			async execute() {
				return [{ type: "text" as const, text: "tool" }];
			},
		} satisfies AgentTool<typeof dynamicParameters>;
		const calls: string[] = [];
		const agent = new Agent({
			provider: faux.provider,
			model: faux.model,
			contextProvider: {
				resolve: () => ({ systemPrompt: "dynamic", tools: [tool] }),
			},
			toolMiddleware: [
				async (_execution, next) => {
					calls.push("before");
					const result = await next(_execution);
					calls.push("after");
					return result;
				},
			],
		});
		await agent.prompt("run dynamic");
		expect(calls).toEqual(["before", "after"]);
	});

	it("keeps request middleware stable while resolving a new context for the next request", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "tool_call", id: "dynamic-1", name: "dynamic", arguments: {} }] },
				{ type: "success", content: [{ type: "text", text: "done" }] },
			],
		});
		const parameters = Type.Object({});
		const tool = {
			name: "dynamic",
			description: "dynamic",
			parameters,
			execute: async () => [{ type: "text" as const, text: "tool" }],
		} satisfies AgentTool<typeof parameters>;
		const calls: string[] = [];
		let resolves = 0;
		const middleware: ToolExecutionMiddleware = async (_execution, next) => {
			calls.push("before");
			const result = await next(_execution);
			calls.push("after");
			return result;
		};
		const agent = new Agent({
			provider: faux.provider,
			model: faux.model,
			contextProvider: {
				resolve: () => {
					resolves++;
					return { tools: [tool], toolMiddleware: resolves === 1 ? [middleware] : [] };
				},
			},
		});
		await agent.prompt("dynamic");
		expect(resolves).toBe(2);
		expect(calls).toEqual(["before", "after"]);
	});

	it("executes a valid tool and sends its result in the next model request", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "call-1",
							name: "echo",
							arguments: { value: "hello" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "done" }] },
			],
			now: () => 20,
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push([...context.messages]);
				return faux.provider.stream(model, context, options);
			},
		};
		const executions: Array<{ id: string; value: string; signal?: AbortSignal }> = [];
		const echo = {
			name: "echo",
			description: "Return the supplied value",
			parameters: echoParameters,
			async execute(id, parameters, signal) {
				executions.push({ id, value: parameters.value, signal });
				return [{ type: "text" as const, text: `echoed: ${parameters.value}` }];
			},
		} satisfies AgentTool<typeof echoParameters>;
		const events: AgentEvent[] = [];
		const agent = new Agent({ provider, model: faux.model, tools: [echo], now: () => 30 });
		agent.subscribe((event) => {
			events.push(event);
		});

		const assistant = await agent.prompt("echo hello");

		expect(assistant).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "done" }] });
		expect(executions).toEqual([{ id: "call-1", value: "hello", signal: undefined }]);
		expect(requestedMessages).toHaveLength(2);
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		expect(agent.transcript.map((message) => message.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
		expect(toolResult(agent.transcript, "call-1")).toMatchObject({
			toolName: "echo",
			isError: false,
			content: [{ type: "text", text: "echoed: hello" }],
		});
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(faux.pendingResponses()).toBe(0);
	});

	it("returns an error result for an unknown tool and lets the model recover", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "missing-1", name: "missing", arguments: {} }],
				},
				{ type: "success", content: [{ type: "text", text: "I cannot use that tool." }] },
			],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });

		const assistant = await agent.prompt("use missing");

		expect(assistant.stopReason).toBe("stop");
		expect(toolResult(agent.transcript, "missing-1")).toMatchObject({
			toolName: "missing",
			isError: true,
			content: [{ type: "text", text: 'Unknown tool "missing".' }],
		});
		expect(faux.pendingResponses()).toBe(0);
	});

	it("does not execute a tool whose arguments fail schema validation", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "invalid-1",
							name: "echo",
							arguments: { value: 42 },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Please pass a string." }] },
			],
		});
		let executions = 0;
		const echo = {
			name: "echo",
			description: "Return the supplied value",
			parameters: echoParameters,
			async execute(_id, parameters) {
				executions++;
				return [{ type: "text" as const, text: parameters.value }];
			},
		} satisfies AgentTool<typeof echoParameters>;
		const agent = new Agent({ provider: faux.provider, model: faux.model, tools: [echo] });

		await agent.prompt("echo a number");

		const result = toolResult(agent.transcript, "invalid-1");
		expect(executions).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
			/Invalid arguments for tool "echo"[\s\S]*\/value/i,
		);
		expect(faux.pendingResponses()).toBe(0);
	});

	it("converts a thrown tool error into a model-visible result", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "failed-1",
							name: "echo",
							arguments: { value: "hello" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The tool failed." }] },
			],
		});
		const echo = {
			name: "echo",
			description: "Return the supplied value",
			parameters: echoParameters,
			async execute() {
				throw new Error("disk offline");
			},
		} satisfies AgentTool<typeof echoParameters>;
		const agent = new Agent({ provider: faux.provider, model: faux.model, tools: [echo] });

		const assistant = await agent.prompt("echo hello");

		expect(assistant.stopReason).toBe("stop");
		expect(toolResult(agent.transcript, "failed-1")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: 'Tool "echo" failed: disk offline' }],
		});
		expect(faux.pendingResponses()).toBe(0);
	});

	it("stops remaining tools and model requests when execution is cancelled", async () => {
		const controller = new AbortController();
		const emptyParameters = Type.Object({});
		const executions: string[] = [];
		const abort = {
			name: "abort",
			description: "Abort this run",
			parameters: emptyParameters,
			async execute(_id, _parameters, signal) {
				executions.push("abort");
				expect(signal).toBe(controller.signal);
				controller.abort("test cancellation");
				return [{ type: "text" as const, text: "too late" }];
			},
		} satisfies AgentTool<typeof emptyParameters>;
		const never = {
			name: "never",
			description: "Must not run after cancellation",
			parameters: emptyParameters,
			async execute() {
				executions.push("never");
				return [{ type: "text" as const, text: "wrong" }];
			},
		} satisfies AgentTool<typeof emptyParameters>;
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{ type: "tool_call", id: "abort-1", name: "abort", arguments: {} },
						{ type: "tool_call", id: "never-1", name: "never", arguments: {} },
					],
				},
				{ type: "success", content: [{ type: "text", text: "must remain queued" }] },
			],
		});
		const starts: string[] = [];
		const agent = new Agent({ provider: faux.provider, model: faux.model, tools: [abort, never] });
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start") starts.push(event.toolCallId);
		});

		const assistant = await agent.prompt("abort", controller.signal);

		expect(assistant.stopReason).toBe("aborted");
		expect(executions).toEqual(["abort"]);
		expect(starts).toEqual(["abort-1"]);
		expect(toolResult(agent.transcript, "abort-1")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "Tool execution aborted." }],
		});
		expect(agent.transcript.map((message) => message.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
		expect(faux.pendingResponses()).toBe(1);
		expect(agent.isStreaming).toBe(false);
	});
});
