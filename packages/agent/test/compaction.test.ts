import {
	type Context,
	createFauxProvider,
	type Message,
	type Model,
	type Provider,
	type StreamOptions,
	type SuccessfulAssistantMessage,
} from "@di-code/ai";
import { describe, expect, it } from "vitest";
import {
	estimateContextTokens,
	estimateMessageTokens,
	generateCompactionSummary,
	prepareCompaction,
	resolveContextBudget,
	serializeConversation,
	shouldCompact,
} from "../src/index.ts";

function userMessage(text: string): Extract<Message, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("context token estimation", () => {
	it("charges structural overhead for an empty user message", () => {
		expect(estimateMessageTokens(userMessage(""))).toBe(1);
	});

	it("rounds text estimates up to the next token", () => {
		expect(estimateMessageTokens(userMessage("abcde"))).toBe(3);
	});

	it("uses the same deterministic rule for Unicode text", () => {
		expect(estimateMessageTokens(userMessage("你好世界"))).toBe(2);
	});

	it("assigns a fixed estimate to images instead of counting Base64 bytes", () => {
		const first: Message = {
			role: "user",
			content: [{ type: "image", data: "a", mimeType: "image/png" }],
			timestamp: 1,
		};
		const second: Message = {
			role: "user",
			content: [{ type: "image", data: "a".repeat(10_000), mimeType: "image/png" }],
			timestamp: 1,
		};

		expect(estimateMessageTokens(first)).toBe(1_201);
		expect(estimateMessageTokens(second)).toBe(1_201);
	});

	it("counts assistant text, thinking, and tool-call data", () => {
		const message: Message = {
			role: "assistant",
			content: [
				{ type: "text", text: "done" },
				{ type: "thinking", thinking: "plan" },
				{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			],
			provider: "faux",
			model: "faux-model",
			usage: {
				input: 999,
				output: 999,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_998,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
			stopReason: "tool_use",
		};

		expect(estimateMessageTokens(message)).toBe(8);
	});

	it("estimates equivalent tool arguments independently of key insertion order", () => {
		const firstArguments = { path: "a.ts", options: { limit: 5, offset: 1 } };
		const secondArguments = { options: { offset: 1, limit: 5 }, path: "a.ts" };
		const createMessage = (argumentsValue: Record<string, unknown>): Message => ({
			role: "assistant",
			content: [{ type: "tool_call", id: "call-1", name: "read", arguments: argumentsValue }],
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
			stopReason: "tool_use",
		});

		expect(estimateMessageTokens(createMessage(firstArguments))).toBe(
			estimateMessageTokens(createMessage(secondArguments)),
		);
	});

	it("sums message estimates without mutating the input", () => {
		const toolResult: Message = {
			role: "tool_result",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		};
		const messages: Message[] = [userMessage("abcd"), toolResult];
		const before = structuredClone(messages);

		expect(estimateMessageTokens(toolResult)).toBe(6);
		expect(estimateContextTokens(messages)).toBe(8);
		expect(messages).toEqual(before);
	});
});

function model(contextWindow: number, maxOutputTokens: number): Model {
	return {
		id: "budget-model",
		name: "Budget Model",
		provider: "faux",
		api: "faux",
		input: ["text"],
		reasoning: false,
		contextWindow,
		maxOutputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("context budget", () => {
	it("reserves the model maximum output when it exceeds ten percent", () => {
		expect(resolveContextBudget(model(1_000, 200))).toEqual({
			contextWindow: 1_000,
			reserveTokens: 200,
			triggerTokens: 800,
		});
	});

	it("reserves at least ten percent of the context window", () => {
		expect(resolveContextBudget(model(1_001, 20))).toEqual({
			contextWindow: 1_001,
			reserveTokens: 101,
			triggerTokens: 900,
		});
	});

	it("triggers at the threshold but not below it", () => {
		const budget = resolveContextBudget(model(1_000, 200));

		expect(shouldCompact(799, budget)).toBe(false);
		expect(shouldCompact(800, budget)).toBe(true);
		expect(shouldCompact(801, budget)).toBe(true);
	});

	it("rejects model metadata that cannot produce a valid input budget", () => {
		expect(() => resolveContextBudget(model(0, 0))).toThrow("model.contextWindow must be a positive integer");
		expect(() => resolveContextBudget(model(100, -1))).toThrow("model.maxOutputTokens must be a non-negative integer");
		expect(() => resolveContextBudget(model(100, 100))).toThrow("Model context budget leaves no room for input");
	});

	it("rejects invalid token estimates before comparing", () => {
		const budget = resolveContextBudget(model(1_000, 200));

		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => shouldCompact(value, budget)).toThrow("estimatedTokens must be a non-negative integer");
		}
	});
});

function assistantMessage(text: string, timestamp: number): SuccessfulAssistantMessage {
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

describe("compaction cut point", () => {
	it("rejects a keep-recent budget that is not a positive integer", () => {
		for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => prepareCompaction([], value)).toThrow("keepRecentTokens must be a positive integer");
		}
	});

	it("returns undefined when no older prefix can be released", () => {
		expect(prepareCompaction([userMessage("only turn"), assistantMessage("answer", 2)], 100)).toBeUndefined();
	});

	it("keeps a complete recent user turn", () => {
		const messages: Message[] = [
			userMessage("x".repeat(36)),
			assistantMessage("x".repeat(36), 2),
			{ ...userMessage("x".repeat(36)), timestamp: 3 },
			assistantMessage("x".repeat(36), 4),
		];

		const preparation = prepareCompaction(messages, 20);

		expect(preparation?.firstKeptMessageIndex).toBe(2);
		expect(preparation?.messagesToSummarize).toEqual(messages.slice(0, 2));
		expect(preparation?.keptMessages).toEqual(messages.slice(2));
		expect(preparation?.tokensBefore).toBe(40);
	});

	it("can split one oversized turn at an assistant message", () => {
		const messages: Message[] = [
			userMessage("request"),
			assistantMessage("x".repeat(76), 2),
			assistantMessage("recent", 3),
		];

		const preparation = prepareCompaction(messages, 20);

		expect(preparation?.firstKeptMessageIndex).toBe(1);
		expect(preparation?.messagesToSummarize).toEqual([messages[0]]);
		expect(preparation?.keptMessages).toEqual(messages.slice(1));
	});

	it("never starts kept context at a tool result", () => {
		const toolCall: Message = {
			...assistantMessage("", 2),
			content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
			stopReason: "tool_use",
		};
		const toolResult: Message = {
			role: "tool_result",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(40) }],
			isError: false,
			timestamp: 3,
		};
		const messages = [userMessage("request"), toolCall, toolResult, assistantMessage("recent", 4)];

		const preparation = prepareCompaction(messages, 20);

		expect(preparation?.firstKeptMessageIndex).toBe(1);
		expect(preparation?.keptMessages[0]?.role).toBe("assistant");
		expect(preparation?.keptMessages).toEqual(messages.slice(1));
	});

	it("returns snapshots that cannot mutate the source history", () => {
		const messages: Message[] = [
			userMessage("x".repeat(36)),
			assistantMessage("x".repeat(36), 2),
			{ ...userMessage("x".repeat(36)), timestamp: 3 },
			assistantMessage("x".repeat(36), 4),
		];
		const before = structuredClone(messages);
		const preparation = prepareCompaction(messages, 20);
		const first = preparation?.messagesToSummarize[0];
		if (first?.content[0]?.type === "text") first.content[0].text = "mutated";

		expect(messages).toEqual(before);
		expect(preparation?.keptMessages).not.toBe(messages);
	});
});

function preparation(messagesToSummarize: readonly Message[]) {
	return {
		messagesToSummarize,
		keptMessages: [userMessage("recent")],
		firstKeptMessageIndex: messagesToSummarize.length,
		tokensBefore: estimateContextTokens([...messagesToSummarize, userMessage("recent")]),
	};
}

describe("compaction summary", () => {
	it("serializes every current role and content block without embedding image data", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "question" },
					{ type: "image", data: "base64-must-not-appear", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				...assistantMessage("answer", 2),
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "answer" },
					{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
				stopReason: "tool_use",
			},
			{
				role: "tool_result",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 3,
			},
		];

		const serialized = serializeConversation(messages);

		expect(serialized).toContain("[User]\nquestion");
		expect(serialized).toContain("[User image: image/png]");
		expect(serialized).not.toContain("base64-must-not-appear");
		expect(serialized).toContain("[Assistant thinking]\nplan");
		expect(serialized).toContain("[Assistant]\nanswer");
		expect(serialized).toContain('[Assistant tool call: read]\n{"path":"a.ts"}');
		expect(serialized).toContain("[Tool result: read, id=call-1, error=false]\ncontents");
	});

	it("requests a bounded summary and returns trimmed text", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "  compact summary  " }] }],
		});
		let requestedContext: Context | undefined;
		let requestedOptions: StreamOptions | undefined;
		const provider: Provider = {
			...faux.provider,
			stream(requestedModel, context, options) {
				requestedContext = structuredClone(context);
				requestedOptions = options;
				return faux.provider.stream(requestedModel, context, options);
			},
		};

		const summary = await generateCompactionSummary(preparation([userMessage("old")]), provider, faux.model, {
			reserveTokens: 100,
			now: () => 123,
		});

		expect(summary).toBe("compact summary");
		expect(requestedContext?.messages).toHaveLength(1);
		expect(requestedContext?.messages[0]).toMatchObject({ role: "user", timestamp: 123 });
		expect(requestedContext?.messages[0]?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("<conversation>\n[User]\nold\n</conversation>"),
		});
		expect(requestedContext?.tools).toBeUndefined();
		expect(requestedOptions?.maxTokens).toBe(50);
	});

	it("rejects a provider error instead of returning a summary", async () => {
		const faux = createFauxProvider({ responses: [{ type: "failure", errorMessage: "summary unavailable" }] });

		await expect(
			generateCompactionSummary(preparation([userMessage("old")]), faux.provider, faux.model, {
				reserveTokens: 100,
			}),
		).rejects.toThrow("Summarization failed: summary unavailable");
	});

	it("passes cancellation to the provider and rejects an aborted summary", async () => {
		const controller = new AbortController();
		controller.abort();
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "unused" }] }],
		});

		await expect(
			generateCompactionSummary(preparation([userMessage("old")]), faux.provider, faux.model, {
				reserveTokens: 100,
				signal: controller.signal,
			}),
		).rejects.toThrow("Summarization aborted");
	});

	it("rejects a successful response without non-empty text", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "   " }] }],
		});

		await expect(
			generateCompactionSummary(preparation([userMessage("old")]), faux.provider, faux.model, {
				reserveTokens: 100,
			}),
		).rejects.toThrow("Summarization returned no text");
	});

	it("rejects a reserve budget that is not a positive integer", async () => {
		const faux = createFauxProvider({ responses: [] });

		await expect(
			generateCompactionSummary(preparation([userMessage("old")]), faux.provider, faux.model, {
				reserveTokens: 0,
			}),
		).rejects.toThrow("reserveTokens must be a positive integer");
		expect(faux.pendingResponses()).toBe(0);
	});

	it("rejects a summary response that requests a tool", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
				},
			],
		});

		await expect(
			generateCompactionSummary(preparation([userMessage("old")]), faux.provider, faux.model, {
				reserveTokens: 100,
			}),
		).rejects.toThrow("Summarization requested a tool");
	});
});
