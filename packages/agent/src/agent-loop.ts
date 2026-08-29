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
import { assemblePromptSections } from "./prompt-sections.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentHookContext,
	AgentHookEvent,
	AgentHookRegistration,
	AgentLoopConfig,
	AgentPreStepDecision,
	AgentRequestAssembly,
	AssistantMessagePreview,
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

function toolDefinitions(context: AgentContext) {
	return context.tools?.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters,
	}));
}

function hookContext(
	phase: AgentHookContext["phase"],
	signal: AbortSignal,
	turnIndex: number,
	stepIndex: number,
): AgentHookContext {
	return { apiVersion: 1, phase, signal, turnIndex, stepIndex };
}

async function invokeHook(
	hook: AgentHookRegistration,
	event: AgentHookEvent,
	context: AgentHookContext,
): Promise<AgentPreStepDecision | undefined> {
	if (hook.apiVersion !== undefined && hook.apiVersion !== 1)
		throw new Error(`Unsupported Agent hook API version: ${hook.apiVersion}`);
	const controller = hook.timeoutMs === undefined ? undefined : new AbortController();
	const onAbort = () => controller?.abort(context.signal.reason);
	if (controller) {
		if (context.signal.aborted) onAbort();
		else context.signal.addEventListener("abort", onAbort, { once: true });
	}
	const hookContextValue = { ...context, signal: controller?.signal ?? context.signal };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = hook.run(event, hookContextValue);
		if (hook.timeoutMs !== undefined) {
			timer = setTimeout(() => controller?.abort(new Error("Agent hook timed out.")), hook.timeoutMs);
			const resolved = await Promise.race([
				Promise.resolve(result),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Agent hook timed out.")), hook.timeoutMs)),
			]);
			return hook.kind === "modifier" && isPreStepDecision(resolved) ? resolved : undefined;
		}
		const resolved = await result;
		return hook.kind === "modifier" && isPreStepDecision(resolved) ? resolved : undefined;
	} finally {
		if (timer) clearTimeout(timer);
		if (controller) context.signal.removeEventListener("abort", onAbort);
	}
}

function isPreStepDecision(value: unknown): value is AgentPreStepDecision {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		["continue", "skip", "abort"].includes(String(value.type))
	);
}

async function runPhaseHooks(
	hooks: readonly AgentHookRegistration[] | undefined,
	phase: AgentHookContext["phase"],
	event: AgentHookEvent,
	signal: AbortSignal,
	turnIndex: number,
	stepIndex: number,
	assembly?: AgentRequestAssembly,
): Promise<AgentRequestAssembly | undefined> {
	let current = assembly;
	for (const hook of hooks ?? []) {
		if (hook.phase !== phase) continue;
		const result = await invokeHook(
			hook,
			{ ...event, assembly: current ?? event.assembly },
			hookContext(phase, signal, turnIndex, stepIndex),
		).catch((error) => {
			if (hook.kind === "observer" || hook.onError === "ignore") return undefined;
			throw error;
		});
		if (phase === "pre_step" && hook.kind === "modifier" && result) {
			if (result.type === "continue") current = result.assembly;
			else throw new Error(result.reason ?? `Agent pre-step decision: ${result.type}`);
		}
	}
	return current;
}

async function streamAssistantResponse(
	messages: Message[],
	context: AgentContext,
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
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => void,
	hooks: readonly AgentHookRegistration[] | undefined,
	turnIndex: number,
	stepIndex: number,
): Promise<ToolResultMessage> {
	await runPhaseHooks(
		hooks,
		"tool_execute_before",
		{ phase: "tool_execute_before", toolCall },
		signal ?? new AbortController().signal,
		turnIndex,
		stepIndex,
	);
	emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		arguments: toolCall.arguments,
	});

	let content: ToolResultContent[];
	let details: JsonValue | undefined;
	let isError = false;
	const tool = context.tools?.find((candidate) => candidate.name === toolCall.name);

	if (signal?.aborted) {
		content = [{ type: "text", text: "Tool execution aborted." }];
		isError = true;
	} else if (!tool) {
		content = [{ type: "text", text: `tool_unavailable: ${toolCall.name}` }];
		details = { code: "tool_unavailable" };
		isError = true;
	} else {
		try {
			const parameters = validateToolArguments(tool, toolCall.arguments);
			const execution = await tool.execute(toolCall.id, parameters, signal);
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
			if (
				cause &&
				typeof cause === "object" &&
				"code" in cause &&
				typeof (cause as { readonly code?: unknown }).code === "string"
			) {
				details = { code: (cause as { readonly code: string }).code };
			}
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
	const operationSignal = signal;
	const hookSignal = signal ?? new AbortController().signal;
	const messages: Message[] = [...context.messages, prompt];
	const emit = (event: AgentEvent): void => stream.push(event);
	let turnIndex = 0;
	let stepIndex = 0;
	try {
		await runPhaseHooks(config.hooks, "request_prepare", { phase: "request_prepare" }, hookSignal, 0, 0);
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		emit({ type: "message_start", message: prompt });
		emit({ type: "message_end", message: prompt });

		while (true) {
			const promptSnapshot = {
				agent: { turnIndex, stepIndex, messageCount: messages.length },
				session: config.getPromptSnapshot?.(),
			};
			const systemPrompt = config.promptSections
				? await assemblePromptSections(config.promptSections.snapshot(), context.systemPrompt, {
						...promptSnapshot,
						signal: hookSignal,
					})
				: context.systemPrompt;
			const baseAssembly: AgentRequestAssembly = {
				systemPrompt,
				messages: [...messages],
				tools: [...(context.tools ?? [])],
			};
			const assembly =
				(await runPhaseHooks(
					config.hooks,
					"pre_step",
					{ phase: "pre_step", assembly: baseAssembly },
					hookSignal,
					turnIndex,
					stepIndex,
					baseAssembly,
				)) ?? baseAssembly;
			const stepContext: AgentContext = {
				systemPrompt: assembly.systemPrompt,
				messages: [...assembly.messages],
				tools: assembly.tools,
			};
			const assistant = await streamAssistantResponse(
				[...assembly.messages],
				stepContext,
				config,
				operationSignal,
				emit,
			);
			await runPhaseHooks(
				config.hooks,
				"request_accept",
				{ phase: "request_accept", message: assistant },
				hookSignal,
				turnIndex,
				stepIndex,
			);
			messages.push(assistant);
			emit({ type: "message_end", message: assistant });

			const toolCalls = getToolCalls(assistant);
			const hasToolCalls = assistant.stopReason === "tool_use" && toolCalls.length > 0;
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
				emit({ type: "turn_end", message: assistant, toolResults: [] });
				await runPhaseHooks(
					config.hooks,
					assistant.stopReason === "aborted" ? "cancelled" : "failed",
					{ phase: assistant.stopReason === "aborted" ? "cancelled" : "failed", message: assistant },
					hookSignal,
					turnIndex,
					stepIndex,
				);
				emit({ type: "agent_end", messages });
				return;
			}

			const toolResults: ToolResultMessage[] = [];
			if (hasToolCalls) {
				for (const toolCall of toolCalls) {
					const result = await executeToolCall(
						toolCall,
						stepContext,
						config,
						operationSignal,
						emit,
						config.hooks,
						turnIndex,
						stepIndex,
					);
					messages.push(result);
					toolResults.push(result);
					if (signal?.aborted) {
						break;
					}
				}
			}
			emit({ type: "turn_end", message: assistant, toolResults });
			await runPhaseHooks(
				config.hooks,
				"step_complete",
				{ phase: "step_complete", message: assistant, toolResult: toolResults.at(-1) },
				hookSignal,
				turnIndex,
				stepIndex,
			);
			await runPhaseHooks(
				config.hooks,
				"turn_complete",
				{ phase: "turn_complete", message: assistant },
				hookSignal,
				turnIndex,
				stepIndex,
			);
			turnIndex++;
			stepIndex++;

			if (operationSignal?.aborted) {
				emit({ type: "turn_start" });
				const aborted = createFailureMessage(config, signal, new Error("Tool loop aborted"));
				messages.push(aborted);
				emit({ type: "message_start", message: createPreview(config, "") });
				emit({ type: "message_end", message: aborted });
				emit({ type: "turn_end", message: aborted, toolResults: [] });
				emit({ type: "agent_end", messages });
				await runPhaseHooks(
					config.hooks,
					"cancelled",
					{ phase: "cancelled", message: aborted },
					hookSignal,
					turnIndex,
					stepIndex,
				);
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
	} catch (cause) {
		const failed = createFailureMessage(config, operationSignal, cause);
		messages.push(failed);
		emit({ type: "message_start", message: createPreview(config, "") });
		emit({ type: "message_end", message: failed });
		emit({ type: "turn_end", message: failed, toolResults: [] });
		await runPhaseHooks(
			config.hooks,
			operationSignal?.aborted ? "cancelled" : "failed",
			{ phase: operationSignal?.aborted ? "cancelled" : "failed", message: failed, error: cause },
			hookSignal,
			turnIndex,
			stepIndex,
		).catch(() => undefined);
		emit({ type: "agent_end", messages });
	} finally {
	}
}
