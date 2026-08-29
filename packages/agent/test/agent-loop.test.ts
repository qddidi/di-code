import { createFauxProvider } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import type { AgentContext, AgentEvent, AgentHookRegistration, AgentMessage } from "../src/index.ts";
import { agentLoop, createPromptSectionRegistry } from "../src/index.ts";

function userMessage(text: string, timestamp = 10): Extract<AgentMessage, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function context(messages: AgentMessage[] = []): AgentContext {
	return { systemPrompt: "You are concise.", messages };
}

describe("agent loop contracts", () => {
	it("assembles dynamic sections on every request with stable order and legacy prefix", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "tool_call", id: "call-1", name: "missing", arguments: {} }] },
				{ type: "success", content: [{ type: "text", text: "done" }] },
			],
		});
		const prompts: string[] = [];
		const sessionIds: Array<string | undefined> = [];
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				request: Parameters<typeof faux.provider.stream>[1],
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				prompts.push(request.systemPrompt ?? "");
				sessionIds.push(options?.sessionId);
				return faux.provider.stream(model, request, options);
			},
		};
		const registry = createPromptSectionRegistry();
		registry.register({ name: "late", order: 20, owner: "test-plugin", generate: () => "late" });
		registry.register({ name: "early", order: 10, owner: "test-plugin", generate: () => "early" });
		const stream = agentLoop(userMessage("hello"), context(), {
			provider,
			model: faux.model,
			sessionId: "cache-session",
			promptSections: registry,
			getPromptSnapshot: () => ({ mode: prompts.length === 0 ? "one" : "two" }),
		});
		await collect(stream);
		expect(prompts).toEqual(["You are concise.\n\nearly\n\nlate", "You are concise.\n\nearly\n\nlate"]);
		expect(sessionIds).toEqual(["cache-session", "cache-session"]);
	});

	it("rejects duplicate names and omits empty sections", async () => {
		const registry = createPromptSectionRegistry();
		const remove = registry.register({ name: "empty", order: 1, owner: "test", generate: () => "   " });
		expect(() => registry.register({ name: "empty", order: 2, owner: "test", generate: () => "x" })).toThrow(
			"Duplicate prompt section",
		);
		remove();
	});
	it("runs versioned hooks in registration order and preserves tool/request order", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "hello" }] }] });
		const calls: string[] = [];
		const hooks: AgentHookRegistration[] = [
			{ kind: "observer", phase: "request_prepare", run: () => calls.push("prepare-1") },
			{ kind: "observer", phase: "request_prepare", run: () => calls.push("prepare-2") },
			{
				kind: "modifier",
				phase: "pre_step",
				run: (event) => {
					calls.push("pre-step");
					if (!event.assembly) throw new Error("missing assembly");
					return { type: "continue", assembly: { ...event.assembly, systemPrompt: "modified" } };
				},
			},
			{ kind: "observer", phase: "request_accept", run: () => calls.push("accepted") },
			{ kind: "observer", phase: "step_complete", run: () => calls.push("step") },
			{ kind: "observer", phase: "turn_complete", run: () => calls.push("turn") },
		];
		const stream = agentLoop(userMessage("hello"), context(), { provider: faux.provider, model: faux.model, hooks });
		await collect(stream);
		expect(calls).toEqual(["prepare-1", "prepare-2", "pre-step", "accepted", "step", "turn"]);
	});

	it("isolates observer failures and recovers modifier failures as an error turn", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "unused" }] }] });
		const observed: string[] = [];
		const stream = agentLoop(userMessage("hello"), context(), {
			provider: faux.provider,
			model: faux.model,
			hooks: [
				{
					kind: "observer",
					phase: "request_prepare",
					run: () => {
						throw new Error("observer broke");
					},
				},
				{ kind: "observer", phase: "failed", run: () => observed.push("failed") },
				{
					kind: "modifier",
					phase: "pre_step",
					run: () => {
						throw new Error("modifier broke");
					},
				},
			],
		});
		const events = await collect(stream);
		const messages = await stream.result();
		expect(observed).toEqual(["failed"]);
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "modifier broke" });
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("passes AbortSignal to hooks and reports cancellation", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "unused" }] }] });
		let cancelled = false;
		const stream = agentLoop(
			userMessage("hello"),
			context(),
			{
				provider: faux.provider,
				model: faux.model,
				hooks: [
					{
						kind: "observer",
						phase: "request_prepare",
						run: (_event, hookContext) => {
							expect(hookContext.signal).toBe(controller.signal);
							controller.abort();
						},
					},
					{
						kind: "observer",
						phase: "cancelled",
						run: (_event, hookContext) => {
							cancelled = hookContext.signal.aborted;
						},
					},
				],
			},
			controller.signal,
		);
		const messages = await stream.result();
		expect(cancelled).toBe(true);
		expect(messages.at(-1)?.role).toBe("assistant");
	});

	it("turns a timed out modifier into a settled error turn", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "unused" }] }] });
		const stream = agentLoop(userMessage("hello"), context(), {
			provider: faux.provider,
			model: faux.model,
			hooks: [
				{
					kind: "modifier",
					phase: "pre_step",
					timeoutMs: 1,
					run: () => new Promise(() => undefined),
				},
			],
		});
		const messages = await stream.result();
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "Agent hook timed out." });
	});
	it("accepts context and preview-shaped lifecycle events", () => {
		const contextValue: AgentContext = { messages: [] };
		const event: AgentEvent = { type: "agent_start" };
		expect(contextValue.messages).toEqual([]);
		expect(event.type).toBe("agent_start");
	});
	it("calls provider once and emits stable text lifecycle", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "hello" }] }],
			chunkSize: 2,
			now: () => 20,
		});
		const stream = agentLoop(userMessage("say hello"), context(), {
			provider: faux.provider,
			model: faux.model,
		});
		const events = await collect(stream);
		const messages = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const updates = events.filter((event) => event.type === "message_update");
		expect(updates.every((event) => !("message" in event))).toBe(true);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[1]).toMatchObject({
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		});
		expect(faux.pendingResponses()).toBe(0);
	});

	it("forwards the stable session id to the provider", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }],
		});
		let requestedSessionId: string | undefined;
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				providerContext: Parameters<typeof faux.provider.stream>[1],
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				requestedSessionId = options?.sessionId;
				return faux.provider.stream(model, providerContext, options);
			},
		};

		const stream = agentLoop(userMessage("cache me"), context(), {
			provider,
			model: faux.model,
			sessionId: "session-cache-1",
		});
		await collect(stream);

		expect(requestedSessionId).toBe("session-cache-1");
	});

	it("settles with a failed assistant message for a model error", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "failure", errorMessage: "model failed" }],
			now: () => 30,
		});
		const stream = agentLoop(userMessage("fail"), context(), {
			provider: faux.provider,
			model: faux.model,
		});
		const events = await collect(stream);
		const messages = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "model failed",
		});
	});

	it("settles after cancellation at the first text delta", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "abcdef" }] }],
			chunkSize: 2,
			now: () => 40,
		});
		const stream = agentLoop(
			userMessage("cancel"),
			context(),
			{ provider: faux.provider, model: faux.model },
			controller.signal,
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "message_update" && event.event.type === "text_delta") {
				controller.abort("test cancellation");
			}
		}
		const messages = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(messages.at(-1)).toMatchObject({
			stopReason: "aborted",
			content: [{ type: "text", text: "ab" }],
		});
	});

	it("normalizes a provider throw into a settled error turn", async () => {
		const model = {
			id: "broken-model",
			name: "Broken",
			provider: "broken",
			api: "broken",
			input: ["text" as const],
			reasoning: false,
			contextWindow: 100,
			maxOutputTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const provider = {
			id: "broken",
			name: "Broken",
			models: [model],
			stream() {
				throw new Error("transport broke");
			},
		};
		const stream = agentLoop(userMessage("throw"), context(), { provider, model });
		const events = await collect(stream);
		const messages = await stream.result();

		expect(events.at(-1)?.type).toBe("agent_end");
		expect(messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "transport broke",
		});
	});
});
