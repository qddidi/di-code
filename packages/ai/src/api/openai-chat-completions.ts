import type { TSchema } from "typebox";
import type {
	AssistantContent,
	Context,
	ImageContent,
	Model,
	StreamOptions,
	StreamResult,
	SuccessfulAssistantMessage,
	ToolCallContent,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseToolArguments } from "../utils/validation.ts";

export interface ChatCompletionsRequest {
	readonly model: string;
	readonly messages: readonly ChatMessage[];
	readonly tools?: readonly ChatFunctionTool[];
	readonly stream: true;
	readonly stream_options: { readonly include_usage: true };
	readonly max_tokens?: number;
	readonly temperature?: number;
}

type ChatMessage =
	| { readonly role: "system" | "user"; readonly content: string }
	| {
			readonly role: "assistant";
			readonly content: string | null;
			readonly tool_calls?: readonly ChatToolCall[];
	  }
	| { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

interface ChatToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatFunctionTool {
	readonly type: "function";
	readonly function: { readonly name: string; readonly description: string; readonly parameters: TSchema };
}

export interface OpenAIChatCompletionsStreamOptions extends StreamOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
}

export interface OpenAIChatCompletionsDependencies {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

class InvalidChatStreamError extends Error {}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidChatStreamError(`${field} must be an object`);
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

function projectImage(model: Model, _block: ImageContent): never {
	throw new Error(`model ${model.id} does not support image input`);
}

function projectMessages(model: Model, context: Context): ChatMessage[] {
	const messages: ChatMessage[] = [];
	if (context.systemPrompt?.length) messages.push({ role: "system", content: context.systemPrompt });
	for (const message of context.messages) {
		if (message.role === "user") {
			const text = message.content
				.map((block) => (block.type === "image" ? projectImage(model, block) : block.text))
				.join("\n");
			messages.push({ role: "user", content: text });
		} else if (message.role === "tool_result") {
			const text = message.content
				.map((block) => (block.type === "image" ? projectImage(model, block) : block.text))
				.join("\n");
			messages.push({ role: "tool", tool_call_id: message.toolCallId, content: text || "(no tool output)" });
		} else {
			const text = message.content
				.filter((block): block is Extract<AssistantContent, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("");
			const toolCalls = message.content
				.filter((block): block is Extract<AssistantContent, { type: "tool_call" }> => block.type === "tool_call")
				.map((block) => ({
					id: block.id,
					type: "function" as const,
					function: { name: block.name, arguments: JSON.stringify(block.arguments) },
				}));
			messages.push({
				role: "assistant",
				content: text || null,
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			});
		}
	}
	return messages;
}

export function buildOpenAIChatCompletionsRequest(
	model: Model,
	context: Context,
	options: StreamOptions = {},
): ChatCompletionsRequest {
	if (model.api !== "zhipu-chat-completions")
		throw new Error('Chat Completions adapter requires model.api to be "zhipu-chat-completions"');
	if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
		throw new Error("maxTokens must be a positive integer");
	}
	if (
		options.temperature !== undefined &&
		(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
	) {
		throw new Error("temperature must be a finite number between 0 and 2");
	}
	return {
		model: model.id,
		messages: projectMessages(model, context),
		...(context.tools?.length
			? { tools: context.tools.map((tool) => ({ type: "function" as const, function: tool })) }
			: {}),
		stream: true,
		stream_options: { include_usage: true },
		...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
		...(options.temperature === undefined ? {} : { temperature: options.temperature }),
	};
}

function createSuccess(
	model: Model,
	content: AssistantContent[],
	usage: Usage,
	reason: "stop" | "length" | "tool_use",
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
		if (dataLines.length) {
			const data = dataLines.join("\n");
			dataLines = [];
			onData(data);
		}
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

export function streamOpenAIChatCompletions(
	model: Model,
	context: Context,
	options: OpenAIChatCompletionsStreamOptions,
	dependencies: OpenAIChatCompletionsDependencies = {},
): StreamResult {
	const stream = createAssistantMessageEventStream();
	const content: AssistantContent[] = [];
	let usage = zeroUsage();
	let active:
		| { kind: "text" | "thinking" | "tool"; value: string; id?: string; name?: string; contentIndex: number }
		| undefined;
	let nextIndex = 0;
	let terminalSeen = false;
	const now = dependencies.now ?? Date.now;
	const finishActive = () => {
		if (!active) return;
		if (active.kind === "text") {
			stream.push({ type: "text_end", contentIndex: active.contentIndex, content: active.value });
			content.push({ type: "text", text: active.value });
		} else if (active.kind === "thinking") {
			stream.push({ type: "thinking_end", contentIndex: active.contentIndex, content: active.value });
			content.push({ type: "thinking", thinking: active.value });
		} else {
			const tool = context.tools?.find((candidate) => candidate.name === active?.name);
			if (!tool || !active.id || !active.name)
				throw new InvalidChatStreamError(`tool ${active?.name ?? ""} is not defined`);
			const toolCall: ToolCallContent = {
				type: "tool_call",
				id: active.id,
				name: active.name,
				arguments: parseToolArguments(tool, active.value) as Record<string, unknown>,
			};
			stream.push({ type: "tool_call_end", contentIndex: active.contentIndex, toolCall });
			content.push(toolCall);
		}
		nextIndex += 1;
		active = undefined;
	};
	const failMessage = (reason: "error" | "aborted", message: string) => ({
		role: "assistant" as const,
		content: [...content],
		provider: model.provider,
		model: model.id,
		usage,
		timestamp: now(),
		stopReason: reason,
		errorMessage: message,
	});
	queueMicrotask(() => {
		stream.push({ type: "start" });
		void (async () => {
			if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			if (!options.apiKey.trim()) throw new Error("API key is required");
			const request = buildOpenAIChatCompletionsRequest(model, context, options);
			const baseUrl = (options.baseUrl ?? model.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4").replace(
				/\/+$/,
				"",
			);
			const response = await (dependencies.fetch ?? globalThis.fetch)(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					accept: "text/event-stream",
					authorization: `Bearer ${options.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
			if (!response.body) throw new Error("response body is missing");
			await consumeSse(
				response.body,
				(data) => {
					if (data === "[DONE]") return;
					const event = record(JSON.parse(data), "event");
					if (event.usage) {
						const u = record(event.usage, "usage");
						usage = {
							...usage,
							input: typeof u.prompt_tokens === "number" ? u.prompt_tokens : usage.input,
							output: typeof u.completion_tokens === "number" ? u.completion_tokens : usage.output,
							totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : usage.totalTokens,
						};
					}
					const choices = Array.isArray(event.choices) ? event.choices : [];
					const choice = choices[0];
					if (!choice) return;
					const c = record(choice, "choice");
					const delta = record(c.delta, "choice.delta");
					const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
					const text = typeof delta.content === "string" ? delta.content : "";
					if (reasoning) {
						if (!active || active.kind !== "thinking") {
							finishActive();
							active = { kind: "thinking", value: "", contentIndex: nextIndex };
							stream.push({ type: "thinking_start", contentIndex: nextIndex });
						}
						active.value += reasoning;
						stream.push({ type: "thinking_delta", contentIndex: active.contentIndex, delta: reasoning });
					}
					if (text) {
						if (!active || active.kind !== "text") {
							finishActive();
							active = { kind: "text", value: "", contentIndex: nextIndex };
							stream.push({ type: "text_start", contentIndex: nextIndex });
						}
						active.value += text;
						stream.push({ type: "text_delta", contentIndex: active.contentIndex, delta: text });
					}
					if (Array.isArray(delta.tool_calls))
						for (const raw of delta.tool_calls) {
							const call = record(raw, "tool_call");
							const fn = record(call.function, "tool_call.function");
							const index = typeof call.index === "number" ? call.index : 0;
							if (!active || active.kind !== "tool" || (active as { index?: number }).index !== index) {
								finishActive();
								active = Object.assign({ kind: "tool" as const, value: "", contentIndex: nextIndex, index }, {});
								active.id = typeof call.id === "string" ? call.id : `call_${index}`;
								active.name = typeof fn.name === "string" ? fn.name : "";
								stream.push({ type: "tool_call_start", contentIndex: nextIndex, id: active.id, name: active.name });
							}
							const args = typeof fn.arguments === "string" ? fn.arguments : "";
							active.value += args;
							if (args)
								stream.push({ type: "tool_call_delta", contentIndex: active.contentIndex, argumentsDelta: args });
						}
					const finish = c.finish_reason;
					if (finish) {
						finishActive();
						const reason = finish === "length" ? "length" : finish === "tool_calls" ? "tool_use" : "stop";
						stream.push({ type: "done", reason, message: createSuccess(model, content, usage, reason, now) });
						terminalSeen = true;
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
				message: failMessage(
					aborted ? "aborted" : "error",
					`${model.provider === "zhipu" ? "Zhipu" : "OpenAI"} request ${aborted ? "aborted" : "failed"}: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			});
			terminalSeen = true;
		});
	});
	return stream;
}
