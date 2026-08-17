import type { TSchema } from "typebox";
import type {
	AssistantContent,
	Context,
	ImageContent,
	Model,
	StreamOptions,
	StreamResult,
	SuccessfulAssistantMessage,
	SuccessfulStopReason,
	ToolCallContent,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseToolArguments } from "../utils/validation.ts";

export interface AnthropicMessagesStreamOptions extends StreamOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
}

export interface AnthropicMessagesDependencies {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

export interface AnthropicMessagesRequest {
	readonly model: string;
	readonly max_tokens: number;
	readonly stream: true;
	readonly system?: string;
	readonly temperature?: number;
	readonly messages: readonly AnthropicMessage[];
	readonly tools?: readonly AnthropicTool[];
}

export type AnthropicMessage =
	| { readonly role: "user"; readonly content: readonly AnthropicUserContent[] }
	| { readonly role: "assistant"; readonly content: readonly AnthropicAssistantContent[] };

export type AnthropicUserContent =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string };
	  }
	| {
			readonly type: "tool_result";
			readonly tool_use_id: string;
			readonly content: readonly AnthropicUserContent[];
			readonly is_error: boolean;
	  };

export type AnthropicAssistantContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> };

export interface AnthropicTool {
	readonly name: string;
	readonly description: string;
	readonly input_schema: TSchema;
}

class InvalidAnthropicStreamError extends Error {}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidAnthropicStreamError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
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

function updateUsage(current: Usage, value: unknown, model: Model): Usage {
	const raw = record(value, "usage");
	const input = typeof raw.input_tokens === "number" ? raw.input_tokens : current.input;
	const output = typeof raw.output_tokens === "number" ? raw.output_tokens : current.output;
	const cacheRead = typeof raw.cache_read_input_tokens === "number" ? raw.cache_read_input_tokens : current.cacheRead;
	const cacheWrite =
		typeof raw.cache_creation_input_tokens === "number" ? raw.cache_creation_input_tokens : current.cacheWrite;
	const cost = {
		input: input * model.cost.input,
		output: output * model.cost.output,
		cacheRead: cacheRead * model.cost.cacheRead,
		cacheWrite: cacheWrite * model.cost.cacheWrite,
	};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
	};
}

function projectImage(model: Model, block: ImageContent): AnthropicUserContent {
	if (!model.input.includes("image")) throw new Error(`Anthropic model ${model.id} does not support image input`);
	return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
}

function projectUserContent(
	model: Model,
	content: readonly ({ type: "text"; text: string } | ImageContent)[],
): AnthropicUserContent[] {
	return content.map((block) =>
		block.type === "image" ? projectImage(model, block) : { type: "text", text: block.text },
	);
}

function projectMessages(model: Model, context: Context): AnthropicMessage[] {
	const messages: AnthropicMessage[] = [];
	for (let index = 0; index < context.messages.length; index += 1) {
		const message = context.messages[index];
		if (message.role === "user") {
			messages.push({ role: "user", content: projectUserContent(model, message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const content: AnthropicAssistantContent[] = [];
			for (const block of message.content) {
				if (block.type === "text") content.push({ type: "text", text: block.text });
				if (block.type === "tool_call")
					content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
			}
			if (content.length > 0) messages.push({ role: "assistant", content });
			continue;
		}
		const results: AnthropicUserContent[] = [];
		while (index < context.messages.length && context.messages[index]?.role === "tool_result") {
			const toolResult = context.messages[index];
			if (toolResult.role !== "tool_result") break;
			results.push({
				type: "tool_result",
				tool_use_id: toolResult.toolCallId,
				content: projectUserContent(model, toolResult.content),
				is_error: toolResult.isError,
			});
			index += 1;
		}
		index -= 1;
		if (results.length > 0) messages.push({ role: "user", content: results });
	}
	return messages;
}

export function buildAnthropicMessagesRequest(
	model: Model,
	context: Context,
	options: StreamOptions = {},
): AnthropicMessagesRequest {
	if (model.api !== "anthropic-messages") {
		throw new Error('Anthropic Messages adapter requires model.api to be "anthropic-messages"');
	}
	if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
		throw new Error("maxTokens must be a positive integer");
	}
	if (
		options.temperature !== undefined &&
		(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)
	) {
		throw new Error("temperature must be a finite number between 0 and 1");
	}
	return {
		model: model.id,
		max_tokens: options.maxTokens ?? model.maxOutputTokens,
		stream: true,
		...(context.systemPrompt?.length ? { system: context.systemPrompt } : {}),
		...(options.temperature === undefined ? {} : { temperature: options.temperature }),
		messages: projectMessages(model, context),
		...(context.tools?.length
			? {
					tools: context.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						input_schema: tool.parameters,
					})),
				}
			: {}),
	};
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
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		onData(data);
	};
	const line = (value: string) => {
		if (!value) return dispatch();
		if (value.startsWith(":")) return;
		const colon = value.indexOf(":");
		const field = colon < 0 ? value : value.slice(0, colon);
		const data = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
		if (field === "data") dataLines.push(data);
	};
	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				line(buffer.slice(0, newline).replace(/\r$/, ""));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		if (buffer) line(buffer.replace(/\r$/, ""));
		dispatch();
	} finally {
		reader.releaseLock();
	}
}

function mapStopReason(value: unknown): SuccessfulStopReason {
	if (value === "max_tokens") return "length";
	if (value === "tool_use") return "tool_use";
	if (value === "end_turn" || value === "stop_sequence") return "stop";
	throw new InvalidAnthropicStreamError(`unsupported Anthropic stop reason ${String(value)}`);
}

function success(
	model: Model,
	content: AssistantContent[],
	usage: Usage,
	reason: SuccessfulStopReason,
	now: () => number,
): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content,
		provider: model.provider,
		model: model.id,
		usage,
		timestamp: now(),
		stopReason: reason,
	};
}

export function streamAnthropicMessages(
	model: Model,
	context: Context,
	options: AnthropicMessagesStreamOptions,
	dependencies: AnthropicMessagesDependencies = {},
): StreamResult {
	const stream = createAssistantMessageEventStream();
	const content: AssistantContent[] = [];
	const blocks = new Map<number, { kind: "text" | "thinking" | "tool"; value: string; id?: string; name?: string }>();
	let usage = zeroUsage();
	let reason: SuccessfulStopReason | undefined;
	let terminalSeen = false;
	const now = dependencies.now ?? Date.now;
	const partialContent = (): AssistantContent[] => {
		const active = blocks.values().next().value;
		if (!active || active.kind === "tool") return [...content];
		return [
			...content,
			active.kind === "text" ? { type: "text", text: active.value } : { type: "thinking", thinking: active.value },
		];
	};
	const fail = (stopReason: "error" | "aborted", message: string) => ({
		role: "assistant" as const,
		content: partialContent(),
		provider: model.provider,
		model: model.id,
		usage,
		timestamp: now(),
		stopReason,
		errorMessage: message,
	});
	queueMicrotask(() => {
		stream.push({ type: "start" });
		void (async () => {
			if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			if (!options.apiKey.trim()) throw new Error("API key is required");
			const request = buildAnthropicMessagesRequest(model, context, options);
			const baseUrl = (options.baseUrl ?? model.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
			const response = await (dependencies.fetch ?? globalThis.fetch)(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					accept: "text/event-stream",
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
					"x-api-key": options.apiKey,
				},
				body: JSON.stringify(request),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
			if (!response.body) throw new Error("response body is missing");
			await consumeSse(
				response.body,
				(data) => {
					const event = record(JSON.parse(data), "event");
					switch (event.type) {
						case "message_start": {
							const message = record(event.message, "message_start.message");
							if (message.usage !== undefined) usage = updateUsage(usage, message.usage, model);
							break;
						}
						case "content_block_start": {
							if (typeof event.index !== "number")
								throw new InvalidAnthropicStreamError("content block index must be a number");
							const block = record(event.content_block, "content_block_start.content_block");
							if (block.type === "text" || block.type === "thinking") {
								blocks.set(event.index, { kind: block.type, value: "" });
								stream.push({
									type: block.type === "text" ? "text_start" : "thinking_start",
									contentIndex: event.index,
								});
								break;
							}
							if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") {
								throw new InvalidAnthropicStreamError("unsupported Anthropic content block");
							}
							const initial =
								typeof block.input === "object" && block.input !== null ? JSON.stringify(block.input) : "";
							blocks.set(event.index, {
								kind: "tool",
								value: initial === "{}" ? "" : initial,
								id: block.id,
								name: block.name,
							});
							stream.push({ type: "tool_call_start", contentIndex: event.index, id: block.id, name: block.name });
							if (initial && initial !== "{}")
								stream.push({ type: "tool_call_delta", contentIndex: event.index, argumentsDelta: initial });
							break;
						}
						case "content_block_delta": {
							if (typeof event.index !== "number")
								throw new InvalidAnthropicStreamError("content block index must be a number");
							const active = blocks.get(event.index);
							if (!active) throw new InvalidAnthropicStreamError("content delta without a started block");
							const delta = record(event.delta, "content_block_delta.delta");
							if (delta.type === "signature_delta") {
								if (typeof delta.signature !== "string")
									throw new InvalidAnthropicStreamError("thinking signature delta must be a string");
								if (active.kind !== "thinking")
									throw new InvalidAnthropicStreamError("thinking signature delta must target a thinking block");
								break;
							}
							const value =
								delta.type === "text_delta"
									? delta.text
									: delta.type === "thinking_delta"
										? delta.thinking
										: delta.type === "input_json_delta"
											? delta.partial_json
											: undefined;
							if (typeof value !== "string")
								throw new InvalidAnthropicStreamError("unsupported Anthropic content delta");
							active.value += value;
							if (value) {
								if (active.kind === "text")
									stream.push({ type: "text_delta", contentIndex: event.index, delta: value });
								if (active.kind === "thinking")
									stream.push({ type: "thinking_delta", contentIndex: event.index, delta: value });
								if (active.kind === "tool")
									stream.push({ type: "tool_call_delta", contentIndex: event.index, argumentsDelta: value });
							}
							break;
						}
						case "content_block_stop": {
							if (typeof event.index !== "number")
								throw new InvalidAnthropicStreamError("content block index must be a number");
							const active = blocks.get(event.index);
							if (!active) throw new InvalidAnthropicStreamError("content stop without a started block");
							if (active.kind === "text") {
								content.push({ type: "text", text: active.value });
								stream.push({ type: "text_end", contentIndex: event.index, content: active.value });
							} else if (active.kind === "thinking") {
								content.push({ type: "thinking", thinking: active.value });
								stream.push({ type: "thinking_end", contentIndex: event.index, content: active.value });
							} else {
								const tool = context.tools?.find((candidate) => candidate.name === active.name);
								if (!tool || !active.id || !active.name)
									throw new InvalidAnthropicStreamError(`tool ${active.name ?? ""} is not defined`);
								const toolCall: ToolCallContent = {
									type: "tool_call",
									id: active.id,
									name: active.name,
									arguments: parseToolArguments(tool, active.value || "{}") as Record<string, unknown>,
								};
								content.push(toolCall);
								stream.push({ type: "tool_call_end", contentIndex: event.index, toolCall });
							}
							blocks.delete(event.index);
							break;
						}
						case "message_delta": {
							const delta = record(event.delta, "message_delta.delta");
							reason = mapStopReason(delta.stop_reason);
							if (event.usage !== undefined) usage = updateUsage(usage, event.usage, model);
							break;
						}
						case "message_stop":
							if (reason === undefined || blocks.size > 0)
								throw new InvalidAnthropicStreamError("message stopped before all content blocks completed");
							stream.push({ type: "done", reason, message: success(model, content, usage, reason, now) });
							terminalSeen = true;
							break;
						case "ping":
							break;
						case "error":
							throw new Error(
								typeof event.error === "object" &&
									event.error !== null &&
									typeof (event.error as Record<string, unknown>).message === "string"
									? ((event.error as Record<string, unknown>).message as string)
									: "Anthropic returned a stream error",
							);
						default:
							throw new InvalidAnthropicStreamError(`unsupported Anthropic event ${String(event.type)}`);
					}
				},
				options.signal,
			);
			if (!terminalSeen) throw new Error("stream ended before a terminal response");
		})().catch((cause: unknown) => {
			if (terminalSeen) return;
			const aborted = options.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError");
			stream.push({
				type: "error",
				reason: aborted ? "aborted" : "error",
				message: fail(
					aborted ? "aborted" : "error",
					`Anthropic request ${aborted ? "aborted" : "failed"}: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			});
			terminalSeen = true;
		});
	});
	return stream;
}
