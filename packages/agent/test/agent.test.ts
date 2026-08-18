import { type Context, createFauxProvider, type Message, type Provider } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";

function userMessage(text: string, timestamp: number): Extract<Message, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, timestamp: number): Extract<Message, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp,
		stopReason: "stop",
	};
}

function failedThinkingMessage(timestamp: number): Extract<Message, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "partial private reasoning" }],
		provider: "openai",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
		stopReason: "error",
		errorMessage: "stream interrupted",
	};
}

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

	it("keeps failed thinking in the transcript but excludes it from the next provider context", async () => {
		const initialMessages: Message[] = [userMessage("interrupted question", 1), failedThinkingMessage(2)];
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "recovered" }] }],
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push(structuredClone(context.messages));
				return faux.provider.stream(model, context, options);
			},
		};
		const agent = new Agent({ provider, model: faux.model, initialMessages });

		await agent.prompt("continue after the interruption");

		expect(requestedMessages[0]?.map((message) => message.role)).toEqual(["user", "user"]);
		expect(agent.transcript.slice(0, 2)).toEqual(initialMessages);
		expect(agent.contextMessages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
	});

	it("uses compressed initial context while retaining the full transcript", async () => {
		const fullHistory: Message[] = [
			userMessage("old question", 1),
			assistantMessage("old answer", 2),
			userMessage("recent question", 3),
			assistantMessage("recent answer", 4),
		];
		const compressedContext: Message[] = [
			userMessage("<conversation-summary>\nold exchange\n</conversation-summary>", 5),
			fullHistory[2] as Message,
			fullHistory[3] as Message,
		];
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "next" }] }] });
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				requestedMessages.push(structuredClone(context.messages));
				return faux.provider.stream(model, context, options);
			},
		};
		const agent = new Agent({
			provider,
			model: faux.model,
			initialMessages: fullHistory,
			initialContextMessages: compressedContext,
			now: () => 10,
		});

		await agent.prompt("new question");

		expect(requestedMessages[0]?.slice(0, -1)).toEqual(compressedContext);
		expect(agent.transcript.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("advances model context with only the current turn", async () => {
		const fullHistory: Message[] = [userMessage("discarded but visible", 1), userMessage("recent", 2)];
		const compressedContext: Message[] = [userMessage("summary", 3), fullHistory[1] as Message];
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		const agent = new Agent({
			provider: faux.provider,
			model: faux.model,
			initialMessages: fullHistory,
			initialContextMessages: compressedContext,
			now: () => 4,
		});

		await agent.prompt("question");

		expect(agent.contextMessages.slice(0, 2)).toEqual(compressedContext);
		expect(agent.contextMessages.slice(2).map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(agent.transcript[0]).toEqual(fullHistory[0]);
	});

	it("deeply isolates context constructor input, getter, and replacement", () => {
		const initialContext: Message[] = [userMessage("initial", 1)];
		const replacement: Message[] = [userMessage("replacement", 2)];
		const faux = createFauxProvider({ responses: [] });
		const agent = new Agent({
			provider: faux.provider,
			model: faux.model,
			initialMessages: [],
			initialContextMessages: initialContext,
		});

		const initialBlock = initialContext[0]?.content[0];
		if (initialBlock?.type === "text") initialBlock.text = "mutated input";
		expect(agent.contextMessages).toEqual([userMessage("initial", 1)]);

		agent.replaceContext(replacement);
		const replacementBlock = replacement[0]?.content[0];
		if (replacementBlock?.type === "text") replacementBlock.text = "mutated replacement";
		const snapshot = agent.contextMessages;
		const snapshotBlock = snapshot[0]?.content[0];
		if (snapshotBlock?.type === "text") snapshotBlock.text = "mutated snapshot";

		expect(agent.contextMessages).toEqual([userMessage("replacement", 2)]);
		expect(agent.transcript).toEqual([]);
	});

	it("defaults model context to initial transcript when no separate context is supplied", () => {
		const initialMessages: Message[] = [userMessage("same source", 1)];
		const faux = createFauxProvider({ responses: [] });
		const agent = new Agent({ provider: faux.provider, model: faux.model, initialMessages });

		expect(agent.contextMessages).toEqual(initialMessages);
	});

	it("uses a replacement model for the next prompt", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }] });
		const alternate = { ...faux.model, id: "alternate-model" };
		const requestedModels: string[] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				requestedModels.push(model.id);
				return faux.provider.stream(faux.model, context, options);
			},
		};
		const agent = new Agent({ provider, model: faux.model });

		agent.setModel(alternate);
		await agent.prompt("question");

		expect(requestedModels).toEqual(["alternate-model"]);
	});

	it("rejects context replacement while a prompt is streaming", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		const agent = new Agent({ provider: faux.provider, model: faux.model });

		const prompt = agent.prompt("question");

		expect(() => agent.replaceContext([userMessage("too late", 2)])).toThrow(
			"Cannot replace Agent context while processing a prompt.",
		);
		await prompt;
		expect(agent.contextMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
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

	it("injects steering after the current turn and before the next provider request", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first answer" }] },
				{ type: "success", content: [{ type: "text", text: "revised answer" }] },
			],
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				requestedMessages.push(structuredClone(context.messages));
				return faux.provider.stream(model, context, options);
			},
		};
		const agent = new Agent({ provider, model: faux.model, now: () => 10 });
		let steered = false;
		agent.subscribe((event) => {
			if (event.type === "message_update" && !steered) {
				steered = true;
				agent.steerWithContent([{ type: "text", text: "revise direction" }]);
			}
		});

		await agent.prompt("start");

		expect(requestedMessages).toHaveLength(2);
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(requestedMessages[1]?.at(-1)).toEqual(userMessage("revise direction", 10));
		expect(agent.transcript.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
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
