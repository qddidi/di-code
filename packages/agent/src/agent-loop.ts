import {
	type AssistantMessage,
	EventStream,
	type JsonValue,
	type Message,
	type ToolCallContent,
	type ToolResultContent,
	type ToolResultMessage,
	type UserMessage,
	validateToolArguments,
} from "@di-code/ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentRequestContext,
	AgentToolResult,
	AssistantMessagePreview,
	ToolExecution,
	ToolExecutionMiddleware,
	ToolExecutor,
} from "./types.ts";

export function agentLoop(
	prompt: UserMessage,
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
): EventStream<AgentEvent, Message[]> {
	const stream = createAgentEventStream();
	queueMicrotask(() => {
		void runAgentLoop(prompt, context, config, signal, stream);
	});
	return stream;
}

function createAgentEventStream(): EventStream<AgentEvent, Message[]> {
	return new EventStream<AgentEvent, Message[]>({
		validate() {},
		isTerminal(event) {
			return event.type === "agent_end";
		},
		getResult(event) {
			if (event.type !== "agent_end") {
				throw new Error("Expected agent_end event");
			}
			return event.messages;
		},
	});
}

function createPreview(config: AgentLoopConfig, text: string): AssistantMessagePreview {
	return {
		role: "assistant",
		provider: config.model.provider,
		model: config.model.id,
		text,
	};
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createFailureMessage(
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	cause: unknown,
): AssistantMessage {
	const aborted = signal?.aborted === true;
	return {
		role: "assistant",
		content: [],
		provider: config.model.provider,
		model: config.model.id,
		usage: zeroUsage(),
		timestamp: (config.now ?? Date.now)(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: cause instanceof Error ? cause.message : String(cause),
	};
}

function toolDefinitions(context: AgentRequestContext) {
	return context.tools.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters,
	}));
}

async function streamAssistantResponse(
	messages: Message[],
	context: AgentRequestContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => void,
): Promise<AssistantMessage> {
	emit({ type: "message_start", message: createPreview(config, "") });

	try {
		const response = config.provider.stream(
			config.model,
			{
				systemPrompt: context.systemPrompt,
				messages: [...messages],
				tools: toolDefinitions(context),
			},
			{ signal, sessionId: config.sessionId, reasoningEffort: config.thinkingLevel },
		);
		let terminalMessage: AssistantMessage | undefined;
		for await (const event of response) {
			if (event.type === "done" || event.type === "error") {
				terminalMessage = event.message;
				continue;
			}
			if (event.type === "start") {
				continue;
			}
			emit({ type: "message_update", event });
		}
		return terminalMessage ?? (await response.result());
	} catch (cause) {
		return createFailureMessage(config, signal, cause);
	}
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every(isJsonValue);
}

function createToolResult(
	toolCall: ToolCallContent,
	content: ToolResultContent[],
	isError: boolean,
	config: AgentLoopConfig,
	details?: JsonValue,
): ToolResultMessage {
	return {
		role: "tool_result",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content,
		details,
		isError,
		timestamp: (config.now ?? Date.now)(),
	};
}

async function executeToolCall(
	toolCall: ToolCallContent,
	context: AgentRequestContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => void,
): Promise<ToolResultMessage> {
	let content: ToolResultContent[];
	let details: JsonValue | undefined;
	let isError = false;
	const tool = context.tools.find((candidate) => candidate.name === toolCall.name);

	if (signal?.aborted) {
		content = [{ type: "text", text: "Tool execution aborted." }];
		isError = true;
	} else if (!tool) {
		content = [{ type: "text", text: `Unknown tool "${toolCall.name}".` }];
		isError = true;
	} else {
		try {
			const parameters = validateToolArguments(tool, toolCall.arguments);
			emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				arguments: toolCall.arguments,
			});
			const executor: ToolExecutor = async (execution: ToolExecution): Promise<AgentToolResult> =>
				execution.tool.execute(execution.toolCallId, execution.parameters as never, execution.signal);
			const composedExecutor = [...requestMiddleware(context, config)]
				.reverse()
				.reduce<ToolExecutor>((next, middleware) => async (execution) => middleware(execution, next), executor);
			const execution = await composedExecutor({ toolCallId: toolCall.id, tool, parameters, signal });
			if (Array.isArray(execution)) content = execution;
			else {
				content = execution.content;
				if (execution.details !== undefined && !isJsonValue(execution.details)) {
					throw new Error("Tool details must be JSON serializable.");
				}
				details = execution.details;
			}
			if (signal?.aborted) {
				content = [{ type: "text", text: "Tool execution aborted." }];
				isError = true;
			}
		} catch (cause) {
			content = signal?.aborted
				? [{ type: "text", text: "Tool execution aborted." }]
				: [{ type: "text", text: `Tool "${toolCall.name}" failed: ${errorMessage(cause)}` }];
			isError = true;
		}
	}

	const result = createToolResult(toolCall, content, isError, config, details);
	emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
	});
	emit({ type: "message_start", message: result });
	emit({ type: "message_end", message: result });
	return result;
}

function requestMiddleware(context: AgentRequestContext, config: AgentLoopConfig): readonly ToolExecutionMiddleware[] {
	return context.toolMiddleware ?? config.toolMiddleware ?? [];
}

async function resolveRequestContext(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
): Promise<AgentRequestContext> {
	const resolved = await config.contextProvider?.resolve(signal);
	if (resolved) {
		return {
			systemPrompt: resolved.systemPrompt,
			tools: [...resolved.tools],
			toolMiddleware: resolved.toolMiddleware ? [...resolved.toolMiddleware] : undefined,
		};
	}
	return {
		systemPrompt: context.systemPrompt,
		tools: [...(context.tools ?? [])],
		toolMiddleware: config.toolMiddleware,
	};
}

function getToolCalls(message: AssistantMessage): ToolCallContent[] {
	return message.content.filter((content): content is ToolCallContent => content.type === "tool_call");
}

async function runAgentLoop(
	prompt: UserMessage,
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, Message[]>,
): Promise<void> {
	const messages: Message[] = [...context.messages, prompt];
	const emit = (event: AgentEvent): void => stream.push(event);

	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({ type: "message_start", message: prompt });
	emit({ type: "message_end", message: prompt });

	while (true) {
		let requestContext: AgentRequestContext;
		try {
			requestContext = await resolveRequestContext(context, config, signal);
		} catch (cause) {
			const assistant = createFailureMessage(config, signal, cause);
			messages.push(assistant);
			emit({ type: "message_start", message: createPreview(config, "") });
			emit({ type: "message_end", message: assistant });
			emit({ type: "turn_end", message: assistant, toolResults: [] });
			emit({ type: "agent_end", messages });
			return;
		}
		const assistant = await streamAssistantResponse(messages, requestContext, config, signal, emit);
		messages.push(assistant);
		emit({ type: "message_end", message: assistant });

		const toolCalls = getToolCalls(assistant);
		const hasToolCalls = assistant.stopReason === "tool_use" && toolCalls.length > 0;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			emit({ type: "turn_end", message: assistant, toolResults: [] });
			emit({ type: "agent_end", messages });
			return;
		}

		const toolResults: ToolResultMessage[] = [];
		if (hasToolCalls) {
			for (const toolCall of toolCalls) {
				const result = await executeToolCall(toolCall, requestContext, config, signal, emit);
				messages.push(result);
				toolResults.push(result);
				if (signal?.aborted) {
					break;
				}
			}
		}
		emit({ type: "turn_end", message: assistant, toolResults });

		if (signal?.aborted) {
			emit({ type: "turn_start" });
			const aborted = createFailureMessage(config, signal, new Error("Tool loop aborted"));
			messages.push(aborted);
			emit({ type: "message_start", message: createPreview(config, "") });
			emit({ type: "message_end", message: aborted });
			emit({ type: "turn_end", message: aborted, toolResults: [] });
			emit({ type: "agent_end", messages });
			return;
		}

		const steeringMessages = config.getSteeringMessages?.() ?? [];
		if (steeringMessages.length > 0) {
			emit({ type: "turn_start" });
			for (const steering of steeringMessages) {
				messages.push(steering);
				emit({ type: "message_start", message: steering });
				emit({ type: "message_end", message: steering });
			}
			continue;
		}

		if (!hasToolCalls) {
			emit({ type: "agent_end", messages });
			return;
		}

		emit({ type: "turn_start" });
	}
}
