import type { TSchema } from "typebox";
import type {
	AssistantContent,
	AssistantMessage,
	Context,
	FailedAssistantMessage,
	ImageContent,
	JsonValue,
	Model,
	StreamOptions,
	StreamResult,
	SuccessfulAssistantMessage,
	SuccessfulStopReason,
	ToolCallContent,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";

export interface OpenAIResponsesInputText {
	readonly type: "input_text";
	readonly text: string;
}

export interface OpenAIResponsesInputImage {
	readonly type: "input_image";
	readonly detail: "auto";
	readonly image_url: string;
}

export type OpenAIResponsesInputContent = OpenAIResponsesInputText | OpenAIResponsesInputImage;

export type OpenAIResponsesFunctionCallOutput = {
	readonly type: "function_call_output";
	readonly call_id: string;
	readonly output: string | readonly OpenAIResponsesInputContent[];
};

export interface OpenAIResponsesOutputText {
	readonly type: "output_text";
	readonly text: string;
	readonly annotations: readonly [];
}

export interface OpenAIResponsesMessageItem {
	readonly type: "message";
	readonly id: string;
	readonly role: "assistant";
	readonly status: "completed" | "incomplete";
	readonly content: readonly OpenAIResponsesOutputText[];
}

export interface OpenAIResponsesReasoningText {
	readonly type: "summary_text" | "reasoning_text";
	readonly text: string;
}

export interface OpenAIResponsesReasoningItem {
	readonly type: "reasoning";
	readonly id: string;
	readonly summary: readonly OpenAIResponsesReasoningText[];
	readonly content?: readonly OpenAIResponsesReasoningText[];
	readonly encrypted_content: string;
	readonly status?: "completed" | "incomplete" | "in_progress";
}

export interface OpenAIResponsesFunctionCallItem {
	readonly type: "function_call";
	readonly id: string;
	readonly call_id: string;
	readonly name: string;
	readonly arguments: string;
	readonly status?: "completed" | "incomplete" | "in_progress";
}

export type OpenAIResponsesReplayItem =
	| OpenAIResponsesMessageItem
	| OpenAIResponsesReasoningItem
	| OpenAIResponsesFunctionCallItem;

export type OpenAIResponsesInputItem =
	| {
			readonly role: "user";
			readonly content: readonly OpenAIResponsesInputContent[];
	  }
	| OpenAIResponsesMessageItem
	| {
			readonly type: "function_call";
			readonly id?: string;
			readonly call_id: string;
			readonly name: string;
			readonly arguments: string;
			readonly status?: "completed" | "incomplete" | "in_progress";
	  }
	| OpenAIResponsesReasoningItem
	| OpenAIResponsesFunctionCallOutput;

export interface OpenAIResponsesFunctionTool {
	readonly type: "function";
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly strict: false;
}

export interface OpenAIResponsesRequest {
	readonly model: string;
	readonly instructions?: string;
	readonly input: readonly OpenAIResponsesInputItem[];
	readonly tools?: readonly OpenAIResponsesFunctionTool[];
	readonly max_output_tokens?: number;
	readonly temperature?: number;
	readonly reasoning?: { readonly summary: "auto" };
	readonly include?: readonly ["reasoning.encrypted_content"];
	readonly stream: true;
	readonly store: false;
}

export interface OpenAIResponsesStreamOptions extends StreamOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
}

export interface OpenAIResponsesDependencies {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

export type OpenAIProviderErrorKind = "authentication" | "rate_limit" | "timeout" | "connection" | "server" | "request";

export interface OpenAIProviderErrorOptions {
	readonly message: string;
	readonly kind: OpenAIProviderErrorKind;
	readonly status?: number;
	readonly code?: string;
	readonly errorType?: string;
	readonly requestId?: string;
	readonly retryable: boolean;
	readonly cause?: unknown;
}

export class OpenAIProviderError extends Error {
	readonly kind: OpenAIProviderErrorKind;
	readonly status?: number;
	readonly code?: string;
	readonly errorType?: string;
	readonly requestId?: string;
	readonly retryable: boolean;
	readonly cause?: unknown;

	constructor(options: OpenAIProviderErrorOptions) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OpenAIProviderError";
		this.kind = options.kind;
		this.status = options.status;
		this.code = options.code;
		this.errorType = options.errorType;
		this.requestId = options.requestId;
		this.retryable = options.retryable;
		this.cause = options.cause;
	}
}

type ActiveOutput =
	| {
			kind: "message";
			outputIndex: number;
			contentIndex: number;
			text: string;
			started: boolean;
	  }
	| {
			kind: "reasoning";
			outputIndex: number;
			contentIndex: number;
			thinking: string;
			started: boolean;
			mode?: "summary" | "content";
			currentPartIndex?: number;
			currentPartText: string;
			currentPartTextDone: boolean;
			currentPartDone: boolean;
			contentDone: boolean;
	  }
	| {
			kind: "function_call";
			outputIndex: number;
			contentIndex: number;
			id: string;
			name: string;
			argumentsJson: string;
			sawArgumentsDelta: boolean;
	  };

interface ResponseProgress {
	active?: ActiveOutput;
	readonly completedContent: AssistantContent[];
	readonly completedOutputIndexes: Set<number>;
	readonly replayOutputItems: Map<number, JsonValue>;
	nextContentIndex: number;
	terminalSeen: boolean;
	usage: Usage;
}

class InvalidOpenAIStreamError extends Error {
	constructor(detail: string) {
		super(`Invalid OpenAI Responses stream: ${detail}`);
		this.name = "InvalidOpenAIStreamError";
	}
}

class OpenAIResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenAIResponseError";
	}
}

function createZeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assertSupportedModel(model: Model): void {
	if (model.provider !== "openai") {
		throw new Error('OpenAI Responses requires model.provider to be "openai"');
	}
	if (model.api !== "openai-responses") {
		throw new Error('OpenAI Responses requires model.api to be "openai-responses"');
	}
}

function assertOptions(options: StreamOptions): void {
	if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
		throw new Error("maxTokens must be a positive integer");
	}
	if (
		options.temperature !== undefined &&
		(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
	) {
		throw new Error("temperature must be a finite number between 0 and 2");
	}
}

function projectImage(model: Model, block: ImageContent): OpenAIResponsesInputImage {
	if (!model.input.includes("image")) {
		throw new Error(`OpenAI model ${model.id} does not support image input`);
	}
	if (!/^image\/[A-Za-z0-9.+-]+$/.test(block.mimeType)) {
		throw new Error("OpenAI image mimeType must be an image media type");
	}
	if (block.data.length === 0) throw new Error("OpenAI image data must not be empty");
	return {
		type: "input_image",
		detail: "auto",
		image_url: `data:${block.mimeType};base64,${block.data}`,
	};
}

function projectToolResult(model: Model, message: ToolResultMessage): OpenAIResponsesInputItem {
	const hasImage = message.content.some((block) => block.type === "image");
	if (hasImage) {
		const output: OpenAIResponsesInputContent[] = [];
		if (message.isError) output.push({ type: "input_text", text: "[tool error]" });
		for (const block of message.content) {
			if (block.type === "image") {
				output.push(projectImage(model, block));
			} else if (block.text.length > 0) {
				output.push({ type: "input_text", text: block.text });
			}
		}
		return {
			type: "function_call_output",
			call_id: message.toolCallId,
			output,
		};
	}

	const textParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "image") continue;
		textParts.push(block.text);
	}

	const text = textParts.join("\n");
	const output = text.length > 0 ? text : "(no tool output)";
	return {
		type: "function_call_output",
		call_id: message.toolCallId,
		output: message.isError ? `[tool error]\n${output}` : output,
	};
}

function replayError(detail: string): Error {
	return new Error(`Invalid OpenAI Responses provider replay: ${detail}`);
}

function replayRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw replayError(`${field} must be an object`);
	return value;
}

function replayString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw replayError(`${field} must be a non-empty string`);
	return value;
}

function replayStatus(value: unknown, field: string): "completed" | "incomplete" | "in_progress" | undefined {
	if (value === undefined) return undefined;
	if (value !== "completed" && value !== "incomplete" && value !== "in_progress") {
		throw replayError(`${field} is invalid`);
	}
	return value;
}

function replayReasoningParts(
	value: unknown,
	field: string,
	expectedType: "summary_text" | "reasoning_text",
): OpenAIResponsesReasoningText[] {
	if (!Array.isArray(value)) throw replayError(`${field} must be an array`);
	return value.map((entry, index) => {
		const part = replayRecord(entry, `${field}[${index}]`);
		if (part.type !== expectedType) throw replayError(`${field}[${index}].type must be "${expectedType}"`);
		if (typeof part.text !== "string") throw replayError(`${field}[${index}].text must be a string`);
		return { type: expectedType, text: part.text };
	});
}

function replayOutputText(value: unknown, field: string): OpenAIResponsesOutputText[] {
	if (!Array.isArray(value)) throw replayError(`${field} must be an array`);
	return value.map((entry, index) => {
		const part = replayRecord(entry, `${field}[${index}]`);
		if (part.type !== "output_text") throw replayError(`${field}[${index}].type must be "output_text"`);
		if (typeof part.text !== "string") throw replayError(`${field}[${index}].text must be a string`);
		return { type: "output_text", text: part.text, annotations: [] };
	});
}

function replayItem(value: unknown, index: number): OpenAIResponsesReplayItem {
	const field = `data.outputItems[${index}]`;
	const item = replayRecord(value, field);
	if (item.type === "message") {
		if (item.role !== "assistant") throw replayError(`${field}.role must be "assistant"`);
		const status = replayStatus(item.status, `${field}.status`);
		if (status !== "completed" && status !== "incomplete") {
			throw replayError(`${field}.status must be "completed" or "incomplete"`);
		}
		return {
			type: "message",
			id: replayString(item.id, `${field}.id`),
			role: "assistant",
			status,
			content: replayOutputText(item.content, `${field}.content`),
		};
	}
	if (item.type === "reasoning") {
		const content =
			item.content === undefined ? undefined : replayReasoningParts(item.content, `${field}.content`, "reasoning_text");
		const status = replayStatus(item.status, `${field}.status`);
		return {
			type: "reasoning",
			id: replayString(item.id, `${field}.id`),
			summary: replayReasoningParts(item.summary, `${field}.summary`, "summary_text"),
			...(content === undefined ? {} : { content }),
			encrypted_content: replayString(item.encrypted_content, `${field}.encrypted_content`),
			...(status === undefined ? {} : { status }),
		};
	}
	if (item.type === "function_call") {
		const status = replayStatus(item.status, `${field}.status`);
		return {
			type: "function_call",
			id: replayString(item.id, `${field}.id`),
			call_id: replayString(item.call_id, `${field}.call_id`),
			name: replayString(item.name, `${field}.name`),
			arguments: replayString(item.arguments, `${field}.arguments`),
			...(status === undefined ? {} : { status }),
		};
	}
	throw replayError(`${field}.type is unsupported`);
}

function readReplayItems(message: AssistantMessage, model: Model): OpenAIResponsesReplayItem[] | undefined {
	const replay = message.providerReplay;
	if (replay === undefined) return undefined;
	if (message.provider !== model.provider || message.model !== model.id) {
		throw new Error("OpenAI Responses provider replay requires the same provider and model");
	}
	if (replay.api !== model.api) {
		throw new Error(`OpenAI Responses provider replay api must be "${model.api}"`);
	}
	const data = replayRecord(replay.data, "data");
	if (!Array.isArray(data.outputItems) || data.outputItems.length === 0) {
		throw replayError("data.outputItems must be a non-empty array");
	}
	return data.outputItems.map(replayItem);
}

function projectMessages(model: Model, context: Context): OpenAIResponsesInputItem[] {
	const input: OpenAIResponsesInputItem[] = [];

	for (const [messageIndex, message] of context.messages.entries()) {
		if (message.role === "user") {
			const content: OpenAIResponsesInputContent[] = [];
			for (const block of message.content) {
				if (block.type === "image") {
					content.push(projectImage(model, block));
					continue;
				}
				content.push({ type: "input_text", text: block.text });
			}
			if (content.length === 0) {
				throw new Error("OpenAI Responses user messages require at least one content block");
			}
			input.push({ role: "user", content });
			continue;
		}

		if (message.role === "tool_result") {
			input.push(projectToolResult(model, message));
			continue;
		}

		const replayItems = readReplayItems(message, model);
		if (replayItems !== undefined) {
			input.push(...replayItems);
			continue;
		}

		let textIndex = 0;
		for (const block of message.content) {
			if (block.type === "thinking") {
				throw new Error("OpenAI Responses thinking replay requires provider replay metadata");
			}
			if (block.type === "tool_call") {
				input.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(block.arguments),
				});
				continue;
			}
			if (block.text.length === 0) continue;
			input.push({
				type: "message",
				id: `msg_di_${messageIndex}_${textIndex}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: block.text, annotations: [] }],
			});
			textIndex += 1;
		}
	}

	return input;
}

export function buildOpenAIResponsesRequest(
	model: Model,
	context: Context,
	options: StreamOptions = {},
): OpenAIResponsesRequest {
	assertSupportedModel(model);
	assertOptions(options);

	return {
		model: model.id,
		input: projectMessages(model, context),
		stream: true,
		store: false,
		...(model.reasoning
			? {
					reasoning: { summary: "auto" as const },
					include: ["reasoning.encrypted_content" as const],
				}
			: {}),
		...(context.systemPrompt !== undefined && context.systemPrompt.length > 0
			? { instructions: context.systemPrompt }
			: {}),
		...(context.tools !== undefined && context.tools.length > 0
			? {
					tools: context.tools.map((tool) => ({
						type: "function" as const,
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						strict: false as const,
					})),
				}
			: {}),
		...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new InvalidOpenAIStreamError(`${field} must be an object`);
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new InvalidOpenAIStreamError(`${field} must be a string`);
	return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
	const result = requireString(value, field);
	if (result.length === 0) throw new InvalidOpenAIStreamError(`${field} must be a non-empty string`);
	return result;
}

function readItemStatus(value: unknown, field: string): "completed" | "incomplete" | "in_progress" | undefined {
	if (value === undefined) return undefined;
	if (value !== "completed" && value !== "incomplete" && value !== "in_progress") {
		throw new InvalidOpenAIStreamError(`${field} is invalid`);
	}
	return value;
}

function readReasoningPartsForReplay(
	value: unknown,
	field: string,
	expectedType: "summary_text" | "reasoning_text",
): JsonValue[] {
	if (!Array.isArray(value)) throw new InvalidOpenAIStreamError(`${field} must be an array`);
	return value.map((entry, index) => {
		const part = requireRecord(entry, `${field}[${index}]`);
		if (requireString(part.type, `${field}[${index}].type`) !== expectedType) {
			throw new InvalidOpenAIStreamError(`${field}[${index}].type must be "${expectedType}"`);
		}
		return { type: expectedType, text: requireString(part.text, `${field}[${index}].text`) };
	});
}

function readOutputTextForReplay(value: unknown, field: string): JsonValue[] {
	if (!Array.isArray(value)) throw new InvalidOpenAIStreamError(`${field} must be an array`);
	return value.map((entry, index) => {
		const part = requireRecord(entry, `${field}[${index}]`);
		if (requireString(part.type, `${field}[${index}].type`) !== "output_text") {
			throw new InvalidOpenAIStreamError(`${field}[${index}].type must be "output_text"`);
		}
		return { type: "output_text", text: requireString(part.text, `${field}[${index}].text`), annotations: [] };
	});
}

function readCompletedReplayItem(item: Record<string, unknown>): JsonValue {
	const itemType = requireString(item.type, "item.type");
	if (itemType === "message") {
		if (item.role !== "assistant") throw new InvalidOpenAIStreamError('item.role must be "assistant"');
		const status = readItemStatus(item.status, "item.status");
		if (status !== "completed" && status !== "incomplete") {
			throw new InvalidOpenAIStreamError('item.status must be "completed" or "incomplete"');
		}
		return {
			type: "message",
			id: requireNonEmptyString(item.id, "item.id"),
			role: "assistant",
			status,
			content: readOutputTextForReplay(item.content, "item.content"),
		};
	}
	if (itemType === "reasoning") {
		const status = readItemStatus(item.status, "item.status");
		const content =
			item.content === undefined || item.content === null
				? undefined
				: readReasoningPartsForReplay(item.content, "item.content", "reasoning_text");
		const encryptedContent =
			item.encrypted_content === undefined || item.encrypted_content === null
				? undefined
				: requireString(item.encrypted_content, "item.encrypted_content");
		return {
			type: "reasoning",
			id: requireNonEmptyString(item.id, "item.id"),
			summary: readReasoningPartsForReplay(item.summary, "item.summary", "summary_text"),
			...(content === undefined ? {} : { content }),
			...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
			...(status === undefined ? {} : { status }),
		};
	}
	if (itemType === "function_call") {
		const status = readItemStatus(item.status, "item.status");
		return {
			type: "function_call",
			id: requireNonEmptyString(item.id, "item.id"),
			call_id: requireNonEmptyString(item.call_id, "item.call_id"),
			name: requireNonEmptyString(item.name, "item.name"),
			arguments: requireString(item.arguments, "item.arguments"),
			...(status === undefined ? {} : { status }),
		};
	}
	throw new InvalidOpenAIStreamError(`unsupported output item type "${itemType}"`);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new InvalidOpenAIStreamError(`${field} must be a non-negative integer`);
	}
	return value as number;
}

function readUsage(responseValue: unknown): Usage {
	const response = requireRecord(responseValue, "response");
	if (response.usage === undefined || response.usage === null) return createZeroUsage();
	const usage = requireRecord(response.usage, "response.usage");
	const inputTokens = requireNonNegativeInteger(usage.input_tokens, "response.usage.input_tokens");
	const outputTokens = requireNonNegativeInteger(usage.output_tokens, "response.usage.output_tokens");
	let cachedTokens = 0;
	if (usage.input_tokens_details !== undefined && usage.input_tokens_details !== null) {
		const details = requireRecord(usage.input_tokens_details, "response.usage.input_tokens_details");
		if (details.cached_tokens !== undefined) {
			cachedTokens = requireNonNegativeInteger(
				details.cached_tokens,
				"response.usage.input_tokens_details.cached_tokens",
			);
		}
	}
	if (cachedTokens > inputTokens) {
		throw new InvalidOpenAIStreamError("cached input tokens must not exceed input tokens");
	}

	return {
		input: inputTokens - cachedTokens,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		totalTokens: inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseArguments(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw new InvalidOpenAIStreamError("function arguments must be valid JSON");
	}
	if (!isRecord(parsed)) {
		throw new InvalidOpenAIStreamError("function arguments must have a JSON object root");
	}
	return parsed;
}

function assertOutputIndex(event: Record<string, unknown>, active: ActiveOutput): void {
	const outputIndex = requireNonNegativeInteger(event.output_index, "output_index");
	if (outputIndex !== active.outputIndex) {
		throw new InvalidOpenAIStreamError(`expected output_index ${active.outputIndex}, received ${outputIndex}`);
	}
}

function getSafePartialContent(progress: ResponseProgress): AssistantContent[] {
	const content = [...progress.completedContent];
	if (progress.active?.kind === "message" && progress.active.started) {
		content.push({ type: "text", text: progress.active.text });
	}
	if (progress.active?.kind === "reasoning" && progress.active.started) {
		content.push({ type: "thinking", thinking: progress.active.thinking });
	}
	return content;
}

function createSuccessMessage(
	model: Model,
	progress: ResponseProgress,
	reason: SuccessfulStopReason,
	now: () => number,
): SuccessfulAssistantMessage {
	const replayOutputItems = [...progress.replayOutputItems.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, item]) => item);
	const reasoningItems = replayOutputItems.filter(
		(item): item is { readonly [key: string]: JsonValue } => isRecord(item) && item.type === "reasoning",
	);
	const canReplay =
		reasoningItems.length > 0 &&
		reasoningItems.every((item) => typeof item.encrypted_content === "string" && item.encrypted_content.length > 0);
	return {
		role: "assistant",
		content: [...progress.completedContent],
		provider: model.provider,
		model: model.id,
		usage: progress.usage,
		timestamp: now(),
		stopReason: reason,
		...(canReplay
			? {
					providerReplay: {
						api: "openai-responses",
						data: { outputItems: replayOutputItems },
					},
				}
			: {}),
	};
}

function createFailureMessage(
	model: Model,
	progress: ResponseProgress,
	reason: "error" | "aborted",
	errorMessage: string,
	now: () => number,
): FailedAssistantMessage {
	return {
		role: "assistant",
		content: getSafePartialContent(progress),
		provider: model.provider,
		model: model.id,
		usage: progress.usage,
		timestamp: now(),
		stopReason: reason,
		errorMessage,
	};
}

function finishTextOutput(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	progress: ResponseProgress,
	active: Extract<ActiveOutput, { kind: "message" }>,
	expectedText?: string,
): void {
	if (!active.started) {
		stream.push({ type: "text_start", contentIndex: active.contentIndex });
		active.started = true;
	}
	if (expectedText !== undefined && expectedText !== active.text) {
		throw new InvalidOpenAIStreamError("completed text must match accumulated text deltas");
	}
	stream.push({ type: "text_end", contentIndex: active.contentIndex, content: active.text });
	progress.completedContent.push({ type: "text", text: active.text });
	progress.completedOutputIndexes.add(active.outputIndex);
	progress.nextContentIndex += 1;
	progress.active = undefined;
}

function finishThinkingOutput(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	progress: ResponseProgress,
	active: Extract<ActiveOutput, { kind: "reasoning" }>,
	expectedText?: string,
): void {
	if (!active.started) {
		stream.push({ type: "thinking_start", contentIndex: active.contentIndex });
		active.started = true;
	}
	if (expectedText !== undefined && expectedText !== active.thinking) {
		if (active.thinking.length !== 0) {
			throw new InvalidOpenAIStreamError("completed reasoning text must match accumulated deltas");
		}
		stream.push({ type: "thinking_delta", contentIndex: active.contentIndex, delta: expectedText });
		active.thinking = expectedText;
	}
	stream.push({ type: "thinking_end", contentIndex: active.contentIndex, content: active.thinking });
	progress.completedContent.push({ type: "thinking", thinking: active.thinking });
	progress.completedOutputIndexes.add(active.outputIndex);
	progress.nextContentIndex += 1;
	progress.active = undefined;
}

function assertReasoningMode(active: Extract<ActiveOutput, { kind: "reasoning" }>, mode: "summary" | "content"): void {
	if (active.mode !== undefined && active.mode !== mode) {
		throw new InvalidOpenAIStreamError("reasoning summary and content events must not be mixed");
	}
	active.mode = mode;
}

function pushThinkingDelta(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	active: Extract<ActiveOutput, { kind: "reasoning" }>,
	delta: string,
): void {
	if (!active.started) {
		stream.push({ type: "thinking_start", contentIndex: active.contentIndex });
		active.started = true;
	}
	stream.push({ type: "thinking_delta", contentIndex: active.contentIndex, delta });
	active.thinking += delta;
}

function startReasoningSummaryPart(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	active: Extract<ActiveOutput, { kind: "reasoning" }>,
	summaryIndex: number,
): void {
	assertReasoningMode(active, "summary");
	if (active.currentPartIndex === summaryIndex) return;
	const expectedIndex = active.currentPartIndex === undefined ? 0 : active.currentPartIndex + 1;
	if (summaryIndex !== expectedIndex) {
		throw new InvalidOpenAIStreamError(`expected reasoning summary_index ${expectedIndex}, received ${summaryIndex}`);
	}
	if (active.currentPartIndex !== undefined && !active.currentPartDone) {
		throw new InvalidOpenAIStreamError("reasoning summary parts must complete before the next part starts");
	}
	if (active.currentPartIndex !== undefined) {
		pushThinkingDelta(stream, active, "\n\n");
	}
	active.currentPartIndex = summaryIndex;
	active.currentPartText = "";
	active.currentPartTextDone = false;
	active.currentPartDone = false;
}

function readReasoningItemText(item: Record<string, unknown>): string | undefined {
	for (const [field, expectedType] of [
		["summary", "summary_text"],
		["content", "reasoning_text"],
	] as const) {
		const value = item[field];
		if (value === undefined || value === null) continue;
		if (!Array.isArray(value)) throw new InvalidOpenAIStreamError(`item.${field} must be an array`);
		const parts = value.map((entry, index) => {
			const part = requireRecord(entry, `item.${field}[${index}]`);
			if (requireString(part.type, `item.${field}[${index}].type`) !== expectedType) {
				throw new InvalidOpenAIStreamError(`item.${field}[${index}].type must be "${expectedType}"`);
			}
			return requireString(part.text, `item.${field}[${index}].text`);
		});
		if (parts.length > 0) return parts.join("\n\n");
	}
	return undefined;
}

function handleOutputItemAdded(
	event: Record<string, unknown>,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	progress: ResponseProgress,
): void {
	if (progress.active) {
		throw new InvalidOpenAIStreamError("output items must not be interleaved");
	}
	const outputIndex = requireNonNegativeInteger(event.output_index, "output_index");
	if (progress.completedOutputIndexes.has(outputIndex)) {
		throw new InvalidOpenAIStreamError(`output_index ${outputIndex} has already completed`);
	}
	const item = requireRecord(event.item, "item");
	const itemType = requireString(item.type, "item.type");
	if (itemType === "message") {
		progress.active = {
			kind: "message",
			outputIndex,
			contentIndex: progress.nextContentIndex,
			text: "",
			started: false,
		};
		return;
	}
	if (itemType === "reasoning") {
		progress.active = {
			kind: "reasoning",
			outputIndex,
			contentIndex: progress.nextContentIndex,
			thinking: "",
			started: false,
			currentPartText: "",
			currentPartTextDone: false,
			currentPartDone: false,
			contentDone: false,
		};
		return;
	}
	if (itemType === "function_call") {
		const active: Extract<ActiveOutput, { kind: "function_call" }> = {
			kind: "function_call",
			outputIndex,
			contentIndex: progress.nextContentIndex,
			id: requireString(item.call_id, "item.call_id"),
			name: requireString(item.name, "item.name"),
			argumentsJson: "",
			sawArgumentsDelta: false,
		};
		progress.active = active;
		stream.push({
			type: "tool_call_start",
			contentIndex: active.contentIndex,
			id: active.id,
			name: active.name,
		});
		return;
	}
	throw new InvalidOpenAIStreamError(`unsupported output item type "${itemType}"`);
}

function handleOutputItemDone(
	event: Record<string, unknown>,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	progress: ResponseProgress,
): void {
	const outputIndex = requireNonNegativeInteger(event.output_index, "output_index");
	const item = requireRecord(event.item, "item");
	const itemType = requireString(item.type, "item.type");
	if (progress.replayOutputItems.has(outputIndex)) {
		throw new InvalidOpenAIStreamError(`output_index ${outputIndex} replay item has already completed`);
	}
	if (itemType === "reasoning") {
		const active = progress.active;
		if (!active || active.kind !== "reasoning" || active.outputIndex !== outputIndex) {
			throw new InvalidOpenAIStreamError("reasoning output completion requires an active reasoning output");
		}
		if (active.mode === "summary" && active.currentPartIndex !== undefined) {
			if (!active.currentPartTextDone) {
				throw new InvalidOpenAIStreamError("reasoning output ended before its summary text completed");
			}
			if (!active.currentPartDone) {
				throw new InvalidOpenAIStreamError("reasoning output ended before its summary part completed");
			}
		}
		if (active.mode === "content" && active.started && !active.contentDone) {
			throw new InvalidOpenAIStreamError("reasoning output ended before its content text completed");
		}
		const finalText = readReasoningItemText(item);
		progress.replayOutputItems.set(outputIndex, readCompletedReplayItem(item));
		if (!active.started && finalText === undefined) {
			progress.completedOutputIndexes.add(outputIndex);
			progress.active = undefined;
			return;
		}
		finishThinkingOutput(stream, progress, active, finalText);
		return;
	}
	if (progress.active?.outputIndex === outputIndex) {
		throw new InvalidOpenAIStreamError(`output_index ${outputIndex} ended before its content completed`);
	}
	if (!progress.completedOutputIndexes.has(outputIndex)) {
		throw new InvalidOpenAIStreamError(`output_index ${outputIndex} completed without a supported content block`);
	}
	if (itemType !== "message" && itemType !== "function_call") {
		throw new InvalidOpenAIStreamError(`unsupported output item type "${itemType}"`);
	}
	progress.replayOutputItems.set(outputIndex, readCompletedReplayItem(item));
}

function supplementReasoningEncryption(responseValue: unknown, progress: ResponseProgress): void {
	const response = requireRecord(responseValue, "response");
	if (response.output === undefined || response.output === null) return;
	if (!Array.isArray(response.output)) throw new InvalidOpenAIStreamError("response.output must be an array");

	const encryptedById = new Map<string, string>();
	for (const [index, value] of response.output.entries()) {
		const item = requireRecord(value, `response.output[${index}]`);
		if (item.type !== "reasoning") continue;
		const id = requireNonEmptyString(item.id, `response.output[${index}].id`);
		if (item.encrypted_content === undefined || item.encrypted_content === null) continue;
		const encryptedContent = requireString(item.encrypted_content, `response.output[${index}].encrypted_content`);
		if (encryptedContent.length > 0) encryptedById.set(id, encryptedContent);
	}

	for (const [outputIndex, value] of progress.replayOutputItems) {
		if (!isRecord(value) || value.type !== "reasoning" || typeof value.id !== "string") continue;
		if (typeof value.encrypted_content === "string" && value.encrypted_content.length > 0) continue;
		const encryptedContent = encryptedById.get(value.id);
		if (encryptedContent !== undefined) {
			progress.replayOutputItems.set(outputIndex, { ...value, encrypted_content: encryptedContent });
		}
	}
}

function handleOpenAIEvent(
	value: unknown,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model,
	progress: ResponseProgress,
	now: () => number,
): void {
	const event = requireRecord(value, "event");
	const eventType = requireString(event.type, "event.type");

	switch (eventType) {
		case "response.created":
		case "response.in_progress":
			return;
		case "response.output_item.added":
			handleOutputItemAdded(event, stream, progress);
			return;
		case "response.reasoning_summary_part.added": {
			const active = progress.active;
			if (!active || active.kind !== "reasoning") {
				throw new InvalidOpenAIStreamError("reasoning summary part requires an active reasoning output");
			}
			assertOutputIndex(event, active);
			const summaryIndex = requireNonNegativeInteger(event.summary_index, "summary_index");
			startReasoningSummaryPart(stream, active, summaryIndex);
			const part = requireRecord(event.part, "part");
			if (requireString(part.type, "part.type") !== "summary_text") {
				throw new InvalidOpenAIStreamError('reasoning summary part.type must be "summary_text"');
			}
			if (requireString(part.text, "part.text").length !== 0) {
				throw new InvalidOpenAIStreamError("added reasoning summary part must start empty");
			}
			return;
		}
		case "response.reasoning_summary_text.delta": {
			const active = progress.active;
			if (!active || active.kind !== "reasoning") {
				throw new InvalidOpenAIStreamError("reasoning summary delta requires an active reasoning output");
			}
			assertOutputIndex(event, active);
			const summaryIndex = requireNonNegativeInteger(event.summary_index, "summary_index");
			startReasoningSummaryPart(stream, active, summaryIndex);
			if (active.currentPartTextDone) {
				throw new InvalidOpenAIStreamError("reasoning summary delta arrived after text completion");
			}
			const delta = requireString(event.delta, "delta");
			pushThinkingDelta(stream, active, delta);
			active.currentPartText += delta;
			return;
		}
		case "response.reasoning_summary_text.done": {
			const active = progress.active;
			if (!active || active.kind !== "reasoning") {
				throw new InvalidOpenAIStreamError("reasoning summary completion requires an active reasoning output");
			}
			assertOutputIndex(event, active);
			const summaryIndex = requireNonNegativeInteger(event.summary_index, "summary_index");
			startReasoningSummaryPart(stream, active, summaryIndex);
			if (requireString(event.text, "text") !== active.currentPartText) {
				throw new InvalidOpenAIStreamError("completed reasoning summary text must match accumulated deltas");
			}
			active.currentPartTextDone = true;
			return;
		}
		case "response.reasoning_summary_part.done": {
			const active = progress.active;
			if (!active || active.kind !== "reasoning") {
				throw new InvalidOpenAIStreamError("reasoning summary part completion requires an active reasoning output");
			}
			assertOutputIndex(event, active);
			const summaryIndex = requireNonNegativeInteger(event.summary_index, "summary_index");
			if (active.currentPartIndex !== summaryIndex || !active.currentPartTextDone) {
				throw new InvalidOpenAIStreamError("reasoning summary part completed before its text");
			}
			const part = requireRecord(event.part, "part");
			if (requireString(part.type, "part.type") !== "summary_text") {
				throw new InvalidOpenAIStreamError('reasoning summary part.type must be "summary_text"');
			}
			if (requireString(part.text, "part.text") !== active.currentPartText) {
				throw new InvalidOpenAIStreamError("completed reasoning summary part must match its text deltas");
			}
			active.currentPartDone = true;
			return;
		}
		case "response.reasoning_text.delta": {
			const active = progress.active;
			if (!active || active.kind !== "reasoning") {
				throw new InvalidOpenAIStreamError("reasoning content delta requires an active reasoning output");
			}
			assertOutputIndex(event, active);
			assertReasoningMode(active, "content");
			if (requireNonNegativeInteger(event.content_index, "content_index") !== 0) {
				throw new InvalidOpenAIStreamError("only one reasoning content part is supported");
			}
			if (active.contentDone) {
				throw new InvalidOpenAIStreamError("reasoning content delta arrived after text completion");
			}
			pushThinkingDelta(stream, active, requireString(event.delta, "delta"));
			return;
		}
		case "response.reasoning_text.done": {
			const active = progress.active;
			if (!active || active.kind !== "reasoning") {
				throw new InvalidOpenAIStreamError("reasoning content completion requires an active reasoning output");
			}
			assertOutputIndex(event, active);
			assertReasoningMode(active, "content");
			if (requireNonNegativeInteger(event.content_index, "content_index") !== 0) {
				throw new InvalidOpenAIStreamError("only one reasoning content part is supported");
			}
			if (requireString(event.text, "text") !== active.thinking) {
				throw new InvalidOpenAIStreamError("completed reasoning content must match accumulated deltas");
			}
			active.contentDone = true;
			return;
		}
		case "response.output_text.delta": {
			const active = progress.active;
			if (!active || active.kind !== "message") {
				throw new InvalidOpenAIStreamError("text delta requires an active message output");
			}
			assertOutputIndex(event, active);
			const contentIndex = requireNonNegativeInteger(event.content_index, "content_index");
			if (contentIndex !== 0) {
				throw new InvalidOpenAIStreamError("only one text content part per message is supported");
			}
			if (!active.started) {
				stream.push({ type: "text_start", contentIndex: active.contentIndex });
				active.started = true;
			}
			const delta = requireString(event.delta, "delta");
			stream.push({ type: "text_delta", contentIndex: active.contentIndex, delta });
			active.text += delta;
			return;
		}
		case "response.output_text.done": {
			const active = progress.active;
			if (!active || active.kind !== "message") {
				throw new InvalidOpenAIStreamError("text completion requires an active message output");
			}
			assertOutputIndex(event, active);
			const contentIndex = requireNonNegativeInteger(event.content_index, "content_index");
			if (contentIndex !== 0) {
				throw new InvalidOpenAIStreamError("only one text content part per message is supported");
			}
			finishTextOutput(stream, progress, active, requireString(event.text, "text"));
			return;
		}
		case "response.function_call_arguments.delta": {
			const active = progress.active;
			if (!active || active.kind !== "function_call") {
				throw new InvalidOpenAIStreamError("function arguments delta requires an active function call");
			}
			assertOutputIndex(event, active);
			const delta = requireString(event.delta, "delta");
			stream.push({ type: "tool_call_delta", contentIndex: active.contentIndex, argumentsDelta: delta });
			active.argumentsJson += delta;
			active.sawArgumentsDelta = true;
			return;
		}
		case "response.function_call_arguments.done": {
			const active = progress.active;
			if (!active || active.kind !== "function_call") {
				throw new InvalidOpenAIStreamError("function arguments completion requires an active function call");
			}
			assertOutputIndex(event, active);
			const finalArguments = requireString(event.arguments, "arguments");
			if (active.sawArgumentsDelta && finalArguments !== active.argumentsJson) {
				throw new InvalidOpenAIStreamError("completed function arguments must match accumulated deltas");
			}
			const toolCall: ToolCallContent = {
				type: "tool_call",
				id: active.id,
				name: active.name,
				arguments: parseArguments(finalArguments),
			};
			stream.push({ type: "tool_call_end", contentIndex: active.contentIndex, toolCall });
			progress.completedContent.push(toolCall);
			progress.completedOutputIndexes.add(active.outputIndex);
			progress.nextContentIndex += 1;
			progress.active = undefined;
			return;
		}
		case "response.output_item.done":
			handleOutputItemDone(event, stream, progress);
			return;
		case "response.content_part.added": {
			const active = progress.active;
			if (!active || (active.kind !== "message" && active.kind !== "reasoning")) {
				throw new InvalidOpenAIStreamError("content part event requires an active message output");
			}
			assertOutputIndex(event, active);
			if (active.kind === "reasoning") return;
			const contentIndex = requireNonNegativeInteger(event.content_index, "content_index");
			if (contentIndex !== 0) {
				throw new InvalidOpenAIStreamError("only one text content part per message is supported");
			}
			return;
		}
		case "response.content_part.done": {
			const outputIndex = requireNonNegativeInteger(event.output_index, "output_index");
			if (progress.active?.kind === "reasoning") {
				assertOutputIndex(event, progress.active);
				return;
			}
			const contentIndex = requireNonNegativeInteger(event.content_index, "content_index");
			if (contentIndex !== 0) {
				throw new InvalidOpenAIStreamError("only one text content part per message is supported");
			}
			if (progress.active?.kind === "message") {
				assertOutputIndex(event, progress.active);
				return;
			}
			if (!progress.completedOutputIndexes.has(outputIndex)) {
				throw new InvalidOpenAIStreamError(`output_index ${outputIndex} has no completed content part`);
			}
			return;
		}
		case "response.completed":
		case "response.incomplete": {
			if (progress.active) {
				if (eventType === "response.incomplete" && progress.active.kind === "message") {
					finishTextOutput(stream, progress, progress.active);
				} else {
					throw new InvalidOpenAIStreamError("terminal response received while an output item is active");
				}
			}
			supplementReasoningEncryption(event.response, progress);
			progress.usage = readUsage(event.response);
			const reason: SuccessfulStopReason =
				eventType === "response.incomplete"
					? "length"
					: progress.completedContent.some((block) => block.type === "tool_call")
						? "tool_use"
						: "stop";
			const message = createSuccessMessage(model, progress, reason, now);
			stream.push({ type: "done", reason, message });
			progress.terminalSeen = true;
			return;
		}
		case "response.failed": {
			const response = requireRecord(event.response, "response");
			const error = requireRecord(response.error, "response.error");
			const message = requireString(error.message, "response.error.message");
			const code = error.code === undefined ? undefined : requireString(error.code, "response.error.code");
			throw new OpenAIResponseError(code ? `${code}: ${message}` : message);
		}
		case "error": {
			const message = requireString(event.message, "error.message");
			const code =
				event.code === undefined || event.code === null ? undefined : requireString(event.code, "error.code");
			throw new OpenAIResponseError(code ? `${code}: ${message}` : message);
		}
		default:
			throw new InvalidOpenAIStreamError(`unsupported event type "${eventType}"`);
	}
}

async function consumeSse(
	body: ReadableStream<Uint8Array>,
	onData: (data: string) => void,
	signal: AbortSignal | undefined,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];

	const dispatch = () => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		onData(data);
	};
	const acceptLine = (line: string) => {
		if (line.length === 0) {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") dataLines.push(value);
	};

	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				acceptLine(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) acceptLine(buffer.replace(/\r$/, ""));
		dispatch();
	} finally {
		reader.releaseLock();
	}
}

function normalizeProducerFailure(
	cause: unknown,
	signal: AbortSignal | undefined,
): { reason: "error" | "aborted"; message: string } {
	if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
		return { reason: "aborted", message: "OpenAI request aborted" };
	}
	if (cause instanceof InvalidOpenAIStreamError || cause instanceof OpenAIResponseError) {
		return { reason: "error", message: cause.message };
	}
	if (cause instanceof OpenAIProviderError) {
		return { reason: "error", message: cause.message };
	}
	return { reason: "error", message: "OpenAI request failed" };
}

async function produceOpenAIResponse(
	model: Model,
	context: Context,
	options: OpenAIResponsesStreamOptions,
	dependencies: OpenAIResponsesDependencies,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	progress: ResponseProgress,
): Promise<void> {
	if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
	if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
		throw new OpenAIResponseError("OpenAI API key is required");
	}
	const request = buildOpenAIResponsesRequest(model, context, options);
	const fetchImpl = dependencies.fetch ?? globalThis.fetch;
	const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
	const response = await fetchImpl(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			accept: "text/event-stream",
			authorization: `Bearer ${options.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(request),
		signal: options.signal,
	});
	if (!response.ok) {
		throw new OpenAIResponseError(`OpenAI request failed with HTTP ${response.status}`);
	}
	if (!response.body) {
		throw new OpenAIResponseError("OpenAI Responses response body is missing");
	}

	await consumeSse(
		response.body,
		(data) => {
			if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			if (data === "[DONE]") return;
			let event: unknown;
			try {
				event = JSON.parse(data) as unknown;
			} catch {
				throw new InvalidOpenAIStreamError("event data must be valid JSON");
			}
			handleOpenAIEvent(event, stream, model, progress, dependencies.now ?? Date.now);
		},
		options.signal,
	);
	if (!progress.terminalSeen) {
		throw new OpenAIResponseError("OpenAI Responses stream ended before a terminal response event");
	}
}

/** Performs one OpenAI Responses HTTP attempt and maps its SSE events into the provider-neutral stream contract. */
export function streamOpenAIResponses(
	model: Model,
	context: Context,
	options: OpenAIResponsesStreamOptions,
	dependencies: OpenAIResponsesDependencies = {},
): StreamResult {
	const stream = createAssistantMessageEventStream();
	const progress: ResponseProgress = {
		completedContent: [],
		completedOutputIndexes: new Set<number>(),
		replayOutputItems: new Map<number, JsonValue>(),
		nextContentIndex: 0,
		terminalSeen: false,
		usage: createZeroUsage(),
	};
	const now = dependencies.now ?? Date.now;

	queueMicrotask(() => {
		stream.push({ type: "start" });
		void produceOpenAIResponse(model, context, options, dependencies, stream, progress).catch((cause: unknown) => {
			if (progress.terminalSeen) return;
			const failure = normalizeProducerFailure(cause, options.signal);
			const message = createFailureMessage(model, progress, failure.reason, failure.message, now);
			stream.push({ type: "error", reason: failure.reason, message });
			progress.terminalSeen = true;
		});
	});

	return stream;
}
