import { type Context, createFauxProvider, type Message, type Provider } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";

describe("Agent state wrapper", () => {
	it("uses initial messages in the next provider request", async () => {
		const initialMessages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "old question" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "old answer" }],
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
				stopReason: "stop",
			},
		];
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "new" }] }] });
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push([...context.messages]);
				return faux.provider.stream(model, context, options);
			},
		};
		const agent = new Agent({ provider, model: faux.model, initialMessages });

		await agent.prompt("new question");

		expect(requestedMessages[0]?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requestedMessages[0]?.[0]).toEqual(initialMessages[0]);
	});

	it("deeply isolates initial messages and transcript snapshots", () => {
		const initialMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 }];
		const faux = createFauxProvider({ responses: [] });
		const agent = new Agent({ provider: faux.provider, model: faux.model, initialMessages });

		initialMessages.push({ role: "user", content: [{ type: "text", text: "outside" }], timestamp: 2 });
		const initialText = initialMessages[0]?.content[0];
		if (initialText?.type === "text") initialText.text = "mutated";
		const snapshot = agent.transcript;
		const snapshotText = snapshot[0]?.content[0];
		if (snapshotText?.type === "text") snapshotText.text = "snapshot mutation";

		expect(agent.transcript).toEqual([{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 }]);
	});

	it("commits transcript only when agent_end arrives", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "hello" }] }],
			now: () => 100,
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model, systemPrompt: "Be brief.", now: () => 10 });
		const snapshots: number[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_update") snapshots.push(agent.state.messages.length);
		});

		expect(agent.state).toEqual({ messages: [], isStreaming: false });
		const assistant = await agent.prompt("say hello");

		expect(assistant).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(snapshots.length).toBeGreaterThan(0);
		expect(snapshots.every((length) => length === 0)).toBe(true);
		expect(agent.transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
		const snapshot = agent.state.messages;
		(snapshot as Message[]).push({ role: "user", content: [{ type: "text", text: "outside" }], timestamp: 999 });
		expect(agent.transcript).toHaveLength(2);
		expect(agent.isStreaming).toBe(false);
	});

	it("returns a failed assistant and clears streaming after a model error", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "failure", errorMessage: "model failed" }],
			now: () => 200,
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });

		const assistant = await agent.prompt("fail");

		expect(assistant).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "model failed" });
		expect(agent.state.messages.at(-1)).toEqual(assistant);
		expect(agent.state.messages.at(-1)).not.toBe(assistant);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("settles an aborted prompt and clears streaming", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "abcdef" }] }],
			chunkSize: 2,
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		agent.subscribe((event) => {
			if (event.type === "message_update" && event.event.type === "text_delta") controller.abort("test cancellation");
		});

		const assistant = await agent.prompt("cancel", controller.signal);

		expect(assistant.stopReason).toBe("aborted");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("awaits listeners in registration order", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "ok" }] },
				{ type: "success", content: [{ type: "text", text: "again" }] },
			],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		const order: string[] = [];
		agent.subscribe(async (event) => {
			if (event.type === "agent_start") {
				order.push("first:start");
				await Promise.resolve();
				order.push("first:end");
			}
		});
		let secondCalls = 0;
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "agent_start") {
				secondCalls++;
				order.push("second");
			}
		});

		await agent.prompt("order");

		expect(order).toEqual(["first:start", "first:end", "second"]);
		expect(secondCalls).toBe(1);
		unsubscribe();
		await agent.prompt("again");
		expect(secondCalls).toBe(1);
	});

	it("rejects listener failure but always clears streaming", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		agent.subscribe((event) => {
			if (event.type === "message_update") throw new Error("listener failed");
		});

		await expect(agent.prompt("listener")).rejects.toThrow("listener failed");
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.transcript).toHaveLength(2);
	});

	it("rejects a second prompt while the first is active", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first" }] },
				{ type: "success", content: [{ type: "text", text: "second" }] },
			],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		const first = agent.prompt("first");

		expect(agent.isStreaming).toBe(true);
		await expect(agent.prompt("second")).rejects.toThrow("Agent is already processing a prompt.");
		await first;
		expect(faux.pendingResponses()).toBe(1);
	});

	it("isolates event payloads from listener mutation", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "original" }] }],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				event.message.content[0] = { type: "text", text: "mutated message_end" };
			}
			if (event.type === "agent_end") {
				event.messages.splice(0, event.messages.length);
			}
		});

		const assistant = await agent.prompt("hello");

		expect(assistant.content).toEqual([{ type: "text", text: "original" }]);
		expect(agent.transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});
