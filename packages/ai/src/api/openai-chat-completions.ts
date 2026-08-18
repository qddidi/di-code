import type { TSchema } from "typebox";
import type {
	AssistantContent,
	Context,
	FailedAssistantMessage,
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
	readonly stream_options?: { readonly include_usage: true };
	readonly max_tokens?: number;
	readonly max_completion_tokens?: number;
	readonly temperature?: number;
	readonly thinking?: { readonly type: "enabled" | "disabled"; readonly clear_thinking?: false };
	readonly reasoning_effort?: "low" | "medium" | "high";
	readonly tool_stream?: true;
}

type ChatMessage =
	| { readonly role: "system" | "user"; readonly content: string }
	| { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: readonly ChatToolCall[] }
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
	readonly providerName?: string;
}

export interface OpenAIChatCompletionsDependencies {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

class InvalidChatStreamError extends Error {}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new InvalidChatStreamError(`${field} must be an object`);
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
			messages.push({
				role: "user",
				content: message.content
					.map((block) => (block.type === "image" ? projectImage(model, block) : block.text))
					.join("\n"),
			});
		} else if (message.role === "tool_result") {
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content:
					message.content
						.map((block) => (block.type === "image" ? projectImage(model, block) : block.text))
						.join("\n") || "(no tool output)",
			});
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
	if (model.api !== "openai-chat-completions")
		throw new Error('Chat Completions adapter requires model.api to be "openai-chat-completions"');
	if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0))
		throw new Error("maxTokens must be a positive integer");
	if (
		options.temperature !== undefined &&
		(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
	)
		throw new Error("temperature must be a finite number between 0 and 2");
	const compat = model.chatCompletionsCompat;
	const request: ChatCompletionsRequest = {
		model: model.id,
		messages: projectMessages(model, context),
		...(context.tools?.length
			? { tools: context.tools.map((tool) => ({ type: "function" as const, function: tool })) }
			: {}),
		stream: true,
		...(compat?.supportsUsageInStreaming === false ? {} : { stream_options: { include_usage: true as const } }),
		...(options.maxTokens === undefined
			? {}
			: { [compat?.maxTokensField ?? "max_completion_tokens"]: options.maxTokens }),
		...(options.temperature === undefined ? {} : { temperature: options.temperature }),
	};
	if (compat?.thinkingFormat === "zai") {
		if (options.reasoningEffort && compat.supportsReasoningEffort) {
			(request as unknown as Record<string, unknown>).thinking = { type: "enabled", clear_thinking: false };
			(request as unknown as Record<string, unknown>).reasoning_effort = options.reasoningEffort;
		} else (request as unknown as Record<string, unknown>).thinking = { type: "disabled" };
	} else if (compat?.thinkingFormat === "deepseek") {
		(request as unknown as Record<string, unknown>).thinking = options.reasoningEffort
			? { type: "enabled" }
			: { type: "disabled" };
		if (options.reasoningEffort && compat.supportsReasoningEffort)
			(request as unknown as Record<string, unknown>).reasoning_effort = options.reasoningEffort;
	}
	if (compat?.zaiToolStream && context.tools?.length)
		(request as unknown as Record<string, unknown>).tool_stream = true;
	return request;
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
			onData(dataLines.join("\n"));
			dataLines = [];
		}
	};
	const line = (value: string) => {
		if (!value) return dispatch();
		if (value.startsWith(":")) return;
		const colon = value.indexOf(":");
		if ((colon < 0 ? value : value.slice(0, colon)) === "data")
			dataLines.push(colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, ""));
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

function usageFrom(value: unknown, current: Usage): Usage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return current;
	const u = value as Record<string, unknown>;
	return {
		...current,
		input: typeof u.prompt_tokens === "number" ? u.prompt_tokens : current.input,
		output: typeof u.completion_tokens === "number" ? u.completion_tokens : current.output,
		totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : current.totalTokens,
	};
}

async function safeHttpError(response: Response): Promise<Error> {
	let detail = "";
	try {
		const parsed = JSON.parse(await response.clone().text()) as unknown;
		const rawError =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>).error
				: undefined;
		if (rawError && typeof rawError === "object" && !Array.isArray(rawError)) {
			const error = rawError as Record<string, unknown>;
			detail = [error.code, error.type, error.message]
				.filter((part): part is string => typeof part === "string")
				.join(": ");
		}
	} catch {
		/* Provider errors are still reported by status when the body is not JSON. */
	}
	return new Error(`HTTP ${response.status}${detail ? ` (${detail.slice(0, 300)})` : ""}`);
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
	let textActive: { value: string; contentIndex: number } | undefined;
	let thinkingActive: { value: string; contentIndex: number } | undefined;
	const tools = new Map<number, { id: string; name: string; value: string; chunks: string[]; contentIndex: number }>();
	let terminalSeen = false;
	let nextIndex = 0;
	const now = dependencies.now ?? Date.now;
	const finishText = () => {
		if (textActive) {
			stream.push({ type: "text_end", contentIndex: textActive.contentIndex, content: textActive.value });
			content.push({ type: "text", text: textActive.value });
			textActive = undefined;
		}
	};
	const finishThinking = () => {
		if (thinkingActive) {
			stream.push({ type: "thinking_end", contentIndex: thinkingActive.contentIndex, content: thinkingActive.value });
			content.push({ type: "thinking", thinking: thinkingActive.value });
			thinkingActive = undefined;
		}
	};
	const finishTool = (index: number) => {
		const active = tools.get(index);
		if (!active) return;
		const definition = context.tools?.find((tool) => tool.name === active.name);
		if (!definition) throw new InvalidChatStreamError(`tool ${active.name} is not defined`);
		const toolCall: ToolCallContent = {
			type: "tool_call",
			id: active.id,
			name: active.name,
			arguments: parseToolArguments(definition, active.value) as Record<string, unknown>,
		};
		stream.push({ type: "tool_call_start", contentIndex: active.contentIndex, id: active.id, name: active.name });
		for (const chunk of active.chunks)
			stream.push({ type: "tool_call_delta", contentIndex: active.contentIndex, argumentsDelta: chunk });
		stream.push({ type: "tool_call_end", contentIndex: active.contentIndex, toolCall });
		content.push(toolCall);
		tools.delete(index);
	};
	const finishAll = () => {
		finishThinking();
		finishText();
		for (const index of [...tools.keys()].sort((a, b) => a - b)) finishTool(index);
	};
	const success = (reason: "stop" | "length" | "tool_use"): SuccessfulAssistantMessage => ({
		role: "assistant",
		content: [...content],
		provider: model.provider,
		model: model.id,
		usage,
		timestamp: now(),
		stopReason: reason,
	});
	const failure = (reason: "error" | "aborted", errorMessage: string): FailedAssistantMessage => ({
		role: "assistant",
		content: [...content],
		provider: model.provider,
		model: model.id,
		usage,
		timestamp: now(),
		stopReason: reason,
		errorMessage,
	});
	queueMicrotask(() => {
		stream.push({ type: "start" });
		void (async () => {
			if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			if (!options.apiKey.trim()) throw new Error("API key is required");
			const request = buildOpenAIChatCompletionsRequest(model, context, options);
			const baseUrl = (options.baseUrl ?? model.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
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
			if (!response.ok) throw await safeHttpError(response);
			if (!response.body) throw new Error("response body is missing");
			await consumeSse(
				response.body,
				(data) => {
					if (data === "[DONE]") return;
					const event = record(JSON.parse(data), "event");
					usage = usageFrom(event.usage, usage);
					const choices = Array.isArray(event.choices) ? event.choices : [];
					if (!choices[0]) return;
					const choice = record(choices[0], "choice");
					usage = usageFrom(choice.usage, usage);
					const delta = record(choice.delta ?? {}, "choice.delta");
					const reasoning =
						[delta.reasoning_content, delta.reasoning, delta.reasoning_text].find(
							(value): value is string => typeof value === "string",
						) ?? "";
					const text = typeof delta.content === "string" ? delta.content : "";
					if (reasoning) {
						finishText();
						if (!thinkingActive) {
							thinkingActive = { value: "", contentIndex: nextIndex++ };
							stream.push({ type: "thinking_start", contentIndex: thinkingActive.contentIndex });
						}
						thinkingActive.value += reasoning;
						stream.push({ type: "thinking_delta", contentIndex: thinkingActive.contentIndex, delta: reasoning });
					}
					if (text) {
						finishThinking();
						if (!textActive) {
							textActive = { value: "", contentIndex: nextIndex++ };
							stream.push({ type: "text_start", contentIndex: textActive.contentIndex });
						}
						textActive.value += text;
						stream.push({ type: "text_delta", contentIndex: textActive.contentIndex, delta: text });
					}
					if (Array.isArray(delta.tool_calls))
						for (const raw of delta.tool_calls) {
							const call = record(raw, "tool_call");
							const fn = record(call.function ?? {}, "tool_call.function");
							const index = typeof call.index === "number" ? call.index : 0;
							finishText();
							finishThinking();
							let active = tools.get(index);
							if (!active) {
								active = {
									id: typeof call.id === "string" ? call.id : `call_${index}`,
									name: typeof fn.name === "string" ? fn.name : "",
									value: "",
									chunks: [],
									contentIndex: nextIndex++,
								};
								tools.set(index, active);
							}
							const args = typeof fn.arguments === "string" ? fn.arguments : "";
							active.value += args;
							if (args) active.chunks.push(args);
						}
					const finish = choice.finish_reason;
					if (finish !== null && finish !== undefined) {
						if (
							finish !== "stop" &&
							finish !== "end" &&
							finish !== "length" &&
							finish !== "tool_calls" &&
							finish !== "function_call"
						)
							throw new InvalidChatStreamError(`unsupported finish_reason ${String(finish)}`);
						finishAll();
						const reason =
							finish === "length"
								? "length"
								: finish === "tool_calls" || finish === "function_call"
									? "tool_use"
									: "stop";
						stream.push({ type: "done", reason, message: success(reason) });
						terminalSeen = true;
					}
				},
				options.signal,
			);
			if (!terminalSeen) throw new Error("stream ended before a terminal response");
		})().catch((cause: unknown) => {
			if (terminalSeen) return;
			try {
				finishAll();
			} catch {
				// Preserve the original provider/stream error when partial tool arguments are invalid.
			}
			const aborted = options.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError");
			const rawMessage = cause instanceof Error ? cause.message : String(cause);
			const safeMessage = options.apiKey.trim()
				? rawMessage.split(options.apiKey.trim()).join("[REDACTED]")
				: rawMessage;
			stream.push({
				type: "error",
				reason: aborted ? "aborted" : "error",
				message: failure(
					aborted ? "aborted" : "error",
					`${options.providerName ?? model.provider} request ${aborted ? "aborted" : "failed"}: ${safeMessage}`,
				),
			});
			terminalSeen = true;
		});
	});
	return stream;
}
