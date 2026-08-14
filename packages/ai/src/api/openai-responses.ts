import type { TSchema } from "typebox";
import type {
	AssistantContent,
	Context,
	FailedAssistantMessage,
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

export interface OpenAIResponsesOutputText {
	readonly type: "output_text";
	readonly text: string;
	readonly annotations: readonly [];
}

export type OpenAIResponsesInputItem =
	| {
			readonly role: "user";
			readonly content: readonly OpenAIResponsesInputText[];
	  }
	| {
			readonly type: "message";
			readonly id: string;
			readonly role: "assistant";
			readonly status: "completed";
			readonly content: readonly OpenAIResponsesOutputText[];
	  }
	| {
			readonly type: "function_call";
			readonly call_id: string;
			readonly name: string;
			readonly arguments: string;
	  }
	| {
			readonly type: "function_call_output";
			readonly call_id: string;
			readonly output: string;
	  };

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

function projectToolResult(message: ToolResultMessage): OpenAIResponsesInputItem {
	const textParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "image") {
			throw new Error("OpenAI Responses image content is not supported in Task 11");
		}
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

function projectMessages(context: Context): OpenAIResponsesInputItem[] {
	const input: OpenAIResponsesInputItem[] = [];

	for (const [messageIndex, message] of context.messages.entries()) {
		if (message.role === "user") {
			const content: OpenAIResponsesInputText[] = [];
			for (const block of message.content) {
				if (block.type === "image") {
					throw new Error("OpenAI Responses image content is not supported in Task 11");
				}
				content.push({ type: "input_text", text: block.text });
			}
			if (content.length === 0) {
				throw new Error("OpenAI Responses user messages require at least one text block");
			}
			input.push({ role: "user", content });
			continue;
		}

		if (message.role === "tool_result") {
			input.push(projectToolResult(message));
			continue;
		}

		let textIndex = 0;
		for (const block of message.content) {
			if (block.type === "thinking") {
				throw new Error("OpenAI Responses thinking replay is not supported in Task 11");
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
	if (options.providerId !== model.provider) assertSupportedModel(model);
	assertOptions(options);

	return {
		model: model.id,
		input: projectMessages(context),
		stream: true,
		store: false,
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
	return content;
}

function createSuccessMessage(
	model: Model,
	progress: ResponseProgress,
	reason: SuccessfulStopReason,
	now: () => number,
): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content: [...progress.completedContent],
		provider: model.provider,
		model: model.id,
		usage: progress.usage,
		timestamp: now(),
		stopReason: reason,
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

function handleOutputItemDone(event: Record<string, unknown>, progress: ResponseProgress): void {
	const outputIndex = requireNonNegativeInteger(event.output_index, "output_index");
	if (progress.active?.outputIndex === outputIndex) {
		throw new InvalidOpenAIStreamError(`output_index ${outputIndex} ended before its content completed`);
	}
	if (!progress.completedOutputIndexes.has(outputIndex)) {
		throw new InvalidOpenAIStreamError(`output_index ${outputIndex} completed without a supported content block`);
	}
	const item = requireRecord(event.item, "item");
	const itemType = requireString(item.type, "item.type");
	if (itemType !== "message" && itemType !== "function_call") {
		throw new InvalidOpenAIStreamError(`unsupported output item type "${itemType}"`);
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
			handleOutputItemDone(event, progress);
			return;
		case "response.content_part.added": {
			const active = progress.active;
			if (!active || active.kind !== "message") {
				throw new InvalidOpenAIStreamError("content part event requires an active message output");
			}
			assertOutputIndex(event, active);
			const contentIndex = requireNonNegativeInteger(event.content_index, "content_index");
			if (contentIndex !== 0) {
				throw new InvalidOpenAIStreamError("only one text content part per message is supported");
			}
			return;
		}
		case "response.content_part.done": {
			const outputIndex = requireNonNegativeInteger(event.output_index, "output_index");
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
