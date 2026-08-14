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

export type AnthropicContentBlock =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string };
	  }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
	| {
			readonly type: "tool_result";
			readonly tool_use_id: string;
			readonly content: string;
			readonly is_error?: boolean;
	  };

export interface AnthropicMessageRequest {
	readonly model: string;
	readonly max_tokens: number;
	readonly system?: string;
	readonly messages: {
		readonly role: "user" | "assistant";
		readonly content: readonly AnthropicContentBlock[];
	}[];
	readonly tools?: readonly { readonly name: string; readonly description: string; readonly input_schema: TSchema }[];
	readonly temperature?: number;
	readonly stream: true;
	readonly thinking?: { readonly type: "enabled"; readonly budget_tokens: number };
}

export interface AnthropicMessagesOptions extends StreamOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
}

export interface AnthropicMessagesDependencies {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

export interface AnthropicProviderErrorOptions {
	readonly message: string;
	readonly status?: number;
	readonly type?: string;
	readonly requestId?: string;
	readonly cause?: unknown;
}

export class AnthropicProviderError extends Error {
	readonly status?: number;
	readonly type?: string;
	readonly requestId?: string;
	readonly cause?: unknown;

	constructor(options: AnthropicProviderErrorOptions) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AnthropicProviderError";
		this.status = options.status;
		this.type = options.type;
		this.requestId = options.requestId;
		this.cause = options.cause;
	}
}

class InvalidAnthropicStreamError extends Error {
	constructor(detail: string) {
		super(`Invalid Anthropic Messages stream: ${detail}`);
		this.name = "InvalidAnthropicStreamError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new InvalidAnthropicStreamError(`${field} must be an object`);
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new InvalidAnthropicStreamError(`${field} must be a string`);
	return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0)
		throw new InvalidAnthropicStreamError(`${field} must be a non-negative integer`);
	return value as number;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseToolInput(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw new InvalidAnthropicStreamError("tool input must be valid JSON");
	}
	if (!isRecord(parsed)) throw new InvalidAnthropicStreamError("tool input must have an object root");
	return parsed;
}

function toImageBlock(data: {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}): AnthropicContentBlock {
	return { type: "image", source: { type: "base64", media_type: data.mimeType, data: data.data } };
}

function projectToolResult(message: ToolResultMessage): AnthropicContentBlock {
	const text =
		message.content
			.map((block) => {
				if (block.type === "image") throw new Error("Anthropic tool result images are not supported in Task 16b");
				return block.text;
			})
			.join("\n") || "(no tool output)";
	return {
		type: "tool_result",
		tool_use_id: message.toolCallId,
		content: text,
		...(message.isError ? { is_error: true } : {}),
	};
}

export function buildAnthropicMessagesRequest(
	model: Model,
	context: Context,
	options: StreamOptions = {},
): AnthropicMessageRequest {
	if (options.providerId !== model.provider && model.provider !== "anthropic") {
		throw new Error('Anthropic Messages requires model provider "anthropic"');
	}
	if (model.api !== "anthropic-messages") {
		throw new Error('Anthropic Messages requires model api "anthropic-messages"');
	}
	const maxTokens = options.maxTokens ?? model.maxOutputTokens;
	if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error("maxTokens must be a positive integer");
	if (
		options.temperature !== undefined &&
		(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)
	) {
		throw new Error("Anthropic temperature must be a finite number between 0 and 1");
	}
	const messages: AnthropicMessageRequest["messages"] = [];
	for (const message of context.messages) {
		if (message.role === "tool_result") {
			messages.push({ role: "user", content: [projectToolResult(message)] });
			continue;
		}
		const content: AnthropicContentBlock[] = [];
		for (const block of message.content) {
			if (message.role === "user") {
				if (block.type === "text") content.push({ type: "text", text: block.text });
				else if (block.type === "image") content.push(toImageBlock(block));
				continue;
			}
			if (block.type === "text") content.push({ type: "text", text: block.text });
			else if (block.type === "tool_call")
				content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
			else if (block.type === "thinking")
				throw new Error("Anthropic thinking replay requires a provider signature and is not supported in Task 16b");
			else throw new Error("Anthropic assistant image content is not supported in Task 16b");
		}
		if (content.length > 0) messages.push({ role: message.role, content });
	}
	return {
		model: model.id,
		max_tokens: maxTokens,
		...(context.systemPrompt ? { system: context.systemPrompt } : {}),
		messages,
		...(context.tools?.length
			? {
					tools: context.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						input_schema: tool.parameters,
					})),
				}
			: {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		stream: true,
		...(model.reasoning
			? { thinking: { type: "enabled", budget_tokens: Math.min(8192, Math.max(1024, Math.floor(maxTokens * 0.2))) } }
			: {}),
	};
}

interface Progress {
	readonly content: AssistantContent[];
	active?: { kind: "text" | "thinking" | "tool"; index: number; text: string; id?: string; name?: string };
	terminal: boolean;
	usage: Usage;
}

function successMessage(
	model: Model,
	progress: Progress,
	reason: SuccessfulStopReason,
	now: () => number,
): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content: [...progress.content],
		provider: model.provider,
		model: model.id,
		usage: progress.usage,
		timestamp: now(),
		stopReason: reason,
	};
}

function failureMessage(
	model: Model,
	progress: Progress,
	reason: "error" | "aborted",
	errorMessage: string,
	now: () => number,
): FailedAssistantMessage {
	const content = [...progress.content];
	if (progress.active?.kind === "text") content.push({ type: "text", text: progress.active.text });
	if (progress.active?.kind === "thinking") content.push({ type: "thinking", thinking: progress.active.text });
	return {
		role: "assistant",
		content,
		provider: model.provider,
		model: model.id,
		usage: progress.usage,
		timestamp: now(),
		stopReason: reason,
		errorMessage,
	};
}

function handleEvent(
	value: unknown,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model,
	progress: Progress,
	now: () => number,
): void {
	const event = requireRecord(value, "event");
	switch (requireString(event.type, "event.type")) {
		case "message_start": {
			const message = requireRecord(event.message, "message");
			const usage = requireRecord(message.usage, "message.usage");
			progress.usage = {
				...progress.usage,
				input: requireNonNegativeInteger(usage.input_tokens, "message.usage.input_tokens"),
			};
			return;
		}
		case "content_block_start": {
			if (progress.active) throw new InvalidAnthropicStreamError("content blocks must not be interleaved");
			const index = requireNonNegativeInteger(event.index, "index");
			const block = requireRecord(event.content_block, "content_block");
			const type = requireString(block.type, "content_block.type");
			if (type === "text") {
				progress.active = { kind: "text", index, text: "" };
				stream.push({ type: "text_start", contentIndex: index });
			} else if (type === "thinking") {
				progress.active = { kind: "thinking", index, text: "" };
				stream.push({ type: "thinking_start", contentIndex: index });
			} else if (type === "tool_use") {
				const active = {
					kind: "tool" as const,
					index,
					text: "",
					id: requireString(block.id, "content_block.id"),
					name: requireString(block.name, "content_block.name"),
				};
				progress.active = active;
				stream.push({ type: "tool_call_start", contentIndex: index, id: active.id, name: active.name });
			} else throw new InvalidAnthropicStreamError(`unsupported content block type "${type}"`);
			return;
		}
		case "content_block_delta": {
			if (!progress.active) throw new InvalidAnthropicStreamError("content delta requires an active block");
			const delta = requireRecord(event.delta, "delta");
			const type = requireString(delta.type, "delta.type");
			if (progress.active.kind === "text" && type === "text_delta") {
				const text = requireString(delta.text, "delta.text");
				progress.active.text += text;
				stream.push({ type: "text_delta", contentIndex: progress.active.index, delta: text });
			} else if (progress.active.kind === "thinking" && type === "thinking_delta") {
				const thinking = requireString(delta.thinking, "delta.thinking");
				progress.active.text += thinking;
				stream.push({ type: "thinking_delta", contentIndex: progress.active.index, delta: thinking });
			} else if (progress.active.kind === "tool" && type === "input_json_delta") {
				const partial = requireString(delta.partial_json, "delta.partial_json");
				progress.active.text += partial;
				stream.push({ type: "tool_call_delta", contentIndex: progress.active.index, argumentsDelta: partial });
			} else throw new InvalidAnthropicStreamError(`delta ${type} does not match active content block`);
			return;
		}
		case "content_block_stop": {
			const active = progress.active;
			if (!active) throw new InvalidAnthropicStreamError("content block stop without an active block");
			if (active.kind === "text") {
				stream.push({ type: "text_end", contentIndex: active.index, content: active.text });
				progress.content.push({ type: "text", text: active.text });
			} else if (active.kind === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: active.index, content: active.text });
				progress.content.push({ type: "thinking", thinking: active.text });
			} else {
				const toolCall: ToolCallContent = {
					type: "tool_call",
					id: active.id as string,
					name: active.name as string,
					arguments: parseToolInput(active.text),
				};
				stream.push({ type: "tool_call_end", contentIndex: active.index, toolCall });
				progress.content.push(toolCall);
			}
			progress.active = undefined;
			return;
		}
		case "message_delta": {
			if (progress.active) throw new InvalidAnthropicStreamError("message delta received before content block stop");
			const delta = requireRecord(event.delta, "message.delta");
			const usage = requireRecord(event.usage, "message.usage");
			progress.usage = {
				...progress.usage,
				output: requireNonNegativeInteger(usage.output_tokens, "message.usage.output_tokens"),
				totalTokens:
					progress.usage.input + requireNonNegativeInteger(usage.output_tokens, "message.usage.output_tokens"),
			};
			const stopReason = delta.stop_reason;
			if (stopReason !== "end_turn" && stopReason !== "max_tokens" && stopReason !== "tool_use")
				throw new InvalidAnthropicStreamError("unsupported stop_reason");
			const reason: SuccessfulStopReason =
				stopReason === "max_tokens" ? "length" : stopReason === "tool_use" ? "tool_use" : "stop";
			stream.push({ type: "done", reason, message: successMessage(model, progress, reason, now) });
			progress.terminal = true;
			return;
		}
		case "message_stop":
			return;
		default:
			throw new InvalidAnthropicStreamError(`unsupported event type`);
	}
}

async function consumeSse(
	body: ReadableStream<Uint8Array>,
	onData: (data: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];
	const dispatch = () => {
		if (dataLines.length > 0) {
			const data = dataLines.join("\n");
			dataLines = [];
			onData(data);
		}
	};
	const accept = (line: string) => {
		if (line.length === 0) return dispatch();
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
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
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				accept(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) accept(buffer.replace(/\r$/, ""));
		dispatch();
	} finally {
		reader.releaseLock();
	}
}

async function produce(
	model: Model,
	context: Context,
	options: AnthropicMessagesOptions,
	dependencies: AnthropicMessagesDependencies,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	progress: Progress,
): Promise<void> {
	if (!options.apiKey.trim()) throw new AnthropicProviderError({ message: "Anthropic API key is required" });
	const response = await (dependencies.fetch ?? globalThis.fetch)(
		`${(options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`,
		{
			method: "POST",
			headers: {
				accept: "text/event-stream",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
				"x-api-key": options.apiKey,
			},
			body: JSON.stringify(buildAnthropicMessagesRequest(model, context, options)),
			signal: options.signal,
		},
	);
	if (!response.ok)
		throw new AnthropicProviderError({
			message: `Anthropic request failed with HTTP ${response.status}`,
			status: response.status,
			requestId: response.headers.get("request-id") ?? undefined,
		});
	if (!response.body) throw new AnthropicProviderError({ message: "Anthropic Messages response body is missing" });
	await consumeSse(
		response.body,
		(data) => {
			if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			let event: unknown;
			try {
				event = JSON.parse(data) as unknown;
			} catch {
				throw new InvalidAnthropicStreamError("event data must be valid JSON");
			}
			handleEvent(event, stream, model, progress, dependencies.now ?? Date.now);
		},
		options.signal,
	);
	if (!progress.terminal)
		throw new AnthropicProviderError({ message: "Anthropic Messages stream ended before message_delta" });
}

export function streamAnthropicMessages(
	model: Model,
	context: Context,
	options: AnthropicMessagesOptions,
	dependencies: AnthropicMessagesDependencies = {},
): StreamResult {
	const stream = createAssistantMessageEventStream();
	const progress: Progress = { content: [], terminal: false, usage: zeroUsage() };
	const now = dependencies.now ?? Date.now;
	queueMicrotask(() => {
		stream.push({ type: "start" });
		void produce(model, context, options, dependencies, stream, progress).catch((cause: unknown) => {
			if (progress.terminal) return;
			const aborted = options.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError");
			stream.push({
				type: "error",
				reason: aborted ? "aborted" : "error",
				message: failureMessage(
					model,
					progress,
					aborted ? "aborted" : "error",
					aborted ? "Anthropic request aborted" : cause instanceof Error ? cause.message : "Anthropic request failed",
					now,
				),
			});
			progress.terminal = true;
		});
	});
	return stream;
}
