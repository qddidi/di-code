import type { Message, Model, Provider, Usage } from "@di-code/ai";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_CHARS = 4;
const IMAGE_TOKENS = 1_200;
const MINIMUM_RESERVE_RATIO = 0.1;

function stableJsonLength(value: unknown): number {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value)?.length ?? 0;
	}
	if (Array.isArray(value)) {
		return 2 + value.reduce((length, item, index) => length + stableJsonLength(item) + (index > 0 ? 1 : 0), 0);
	}

	const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return (
		2 +
		entries.reduce(
			(length, [key, item], index) =>
				length + JSON.stringify(key).length + 1 + stableJsonLength(item) + (index > 0 ? 1 : 0),
			0,
		)
	);
}

function estimateContentChars(message: Message): number {
	let chars = MESSAGE_OVERHEAD_CHARS;

	if (message.role === "tool_result") {
		chars += message.toolCallId.length + message.toolName.length + 1;
	}

	for (const block of message.content) {
		switch (block.type) {
			case "text":
				chars += block.text.length;
				break;
			case "thinking":
				chars += block.thinking.length;
				break;
			case "image":
				chars += IMAGE_TOKENS * CHARS_PER_TOKEN;
				break;
			case "tool_call":
				chars += block.name.length + stableJsonLength(block.arguments);
				break;
			default: {
				const unhandled: never = block;
				throw new TypeError(`Unsupported content block: ${JSON.stringify(unhandled)}`);
			}
		}
	}

	return chars;
}

export function estimateMessageTokens(message: Message): number {
	return Math.ceil(estimateContentChars(message) / CHARS_PER_TOKEN);
}

export function estimateContextTokens(messages: readonly Message[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export interface ContextBudget {
	readonly contextWindow: number;
	readonly reserveTokens: number;
	readonly triggerTokens: number;
}

export function resolveContextBudget(model: Model): ContextBudget {
	if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
		throw new RangeError("model.contextWindow must be a positive integer");
	}
	if (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 0) {
		throw new RangeError("model.maxOutputTokens must be a non-negative integer");
	}

	const reserveTokens = Math.max(model.maxOutputTokens, Math.ceil(model.contextWindow * MINIMUM_RESERVE_RATIO));
	if (reserveTokens >= model.contextWindow) {
		throw new RangeError("Model context budget leaves no room for input");
	}

	return {
		contextWindow: model.contextWindow,
		reserveTokens,
		triggerTokens: model.contextWindow - reserveTokens,
	};
}

export function shouldCompact(estimatedTokens: number, budget: ContextBudget): boolean {
	if (!Number.isInteger(estimatedTokens) || estimatedTokens < 0) {
		throw new RangeError("estimatedTokens must be a non-negative integer");
	}
	return estimatedTokens >= budget.triggerTokens;
}

export interface CompactionPreparation {
	readonly messagesToSummarize: readonly Message[];
	readonly keptMessages: readonly Message[];
	readonly firstKeptMessageIndex: number;
	readonly tokensBefore: number;
}

function findTurnStart(messages: readonly Message[], fromIndex: number): number {
	for (let index = fromIndex; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

export function prepareCompaction(
	messages: readonly Message[],
	keepRecentTokens: number,
): CompactionPreparation | undefined {
	if (!Number.isInteger(keepRecentTokens) || keepRecentTokens <= 0) {
		throw new RangeError("keepRecentTokens must be a positive integer");
	}

	let accumulatedTokens = 0;
	let candidateIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		accumulatedTokens += estimateMessageTokens(messages[index] as Message);
		if (accumulatedTokens >= keepRecentTokens && messages[index]?.role !== "tool_result") {
			candidateIndex = index;
			break;
		}
	}

	if (candidateIndex <= 0) return undefined;
	const turnStartIndex = findTurnStart(messages, candidateIndex);
	const firstKeptMessageIndex = turnStartIndex > 0 ? turnStartIndex : candidateIndex;
	if (firstKeptMessageIndex <= 0 || firstKeptMessageIndex >= messages.length) return undefined;

	return {
		messagesToSummarize: structuredClone(messages.slice(0, firstKeptMessageIndex)),
		keptMessages: structuredClone(messages.slice(firstKeptMessageIndex)),
		firstKeptMessageIndex,
		tokensBefore: estimateContextTokens(messages),
	};
}

function serializeContent(message: Message): string[] {
	const lines: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				if (message.role === "user") lines.push("[User]");
				if (message.role === "assistant") lines.push("[Assistant]");
				lines.push(block.text);
				break;
			case "image":
				lines.push(
					message.role === "user" ? `[User image: ${block.mimeType}]` : `[Tool result image: ${block.mimeType}]`,
				);
				break;
			case "thinking":
				lines.push("[Assistant thinking]", block.thinking);
				break;
			case "tool_call":
				lines.push(`[Assistant tool call: ${block.name}]`, JSON.stringify(block.arguments));
				break;
			default: {
				const unhandled: never = block;
				throw new TypeError(`Unsupported content block: ${JSON.stringify(unhandled)}`);
			}
		}
	}
	return lines;
}

export function serializeConversation(messages: readonly Message[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "tool_result") {
			lines.push(`[Tool result: ${message.toolName}, id=${message.toolCallId}, error=${String(message.isError)}]`);
		}
		lines.push(...serializeContent(message));
	}
	return lines.join("\n");
}

export interface GenerateCompactionSummaryOptions {
	readonly reserveTokens: number;
	readonly signal?: AbortSignal;
	readonly now?: () => number;
	readonly onUsage?: (usage: Usage) => void;
}

const SUMMARIZATION_SYSTEM_PROMPT =
	"Summarize the supplied conversation for another model that will continue the work. Preserve goals, constraints, decisions, progress, exact names, paths, errors, and next steps. Do not continue the conversation.";

export async function generateCompactionSummary(
	preparation: CompactionPreparation,
	provider: Provider,
	model: Model,
	options: GenerateCompactionSummaryOptions,
): Promise<string> {
	if (!Number.isInteger(options.reserveTokens) || options.reserveTokens <= 0) {
		throw new RangeError("reserveTokens must be a positive integer");
	}

	const conversation = serializeConversation(preparation.messagesToSummarize);
	const stream = provider.stream(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `<conversation>\n${conversation}\n</conversation>` }],
					timestamp: (options.now ?? Date.now)(),
				},
			],
		},
		{
			signal: options.signal,
			maxTokens: Math.max(1, Math.min(model.maxOutputTokens, Math.floor(options.reserveTokens / 2))),
		},
	);
	const response = await stream.result();
	options.onUsage?.(response.usage);

	switch (response.stopReason) {
		case "error":
			throw new Error(`Summarization failed: ${response.errorMessage}`);
		case "aborted":
			throw new Error("Summarization aborted");
		case "tool_use":
			throw new Error("Summarization requested a tool");
		case "stop":
		case "length": {
			const summary = response.content
				.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("")
				.trim();
			if (summary.length === 0) throw new Error("Summarization returned no text");
			return summary;
		}
		default: {
			const unhandled: never = response;
			throw new TypeError(`Unsupported summary response: ${JSON.stringify(unhandled)}`);
		}
	}
}
