import { type AssistantMessage, EventStream, type Message, type UserMessage } from "@di-code/ai";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessagePreview } from "./types.ts";

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

	let text = "";
	emit({ type: "message_start", message: createPreview(config, text) });

	let assistant: AssistantMessage;
	try {
		const response = config.provider.stream(config.model, { systemPrompt: context.systemPrompt, messages }, { signal });
		let terminalMessage: AssistantMessage | undefined;
		for await (const event of response) {
			if (event.type === "done" || event.type === "error") {
				terminalMessage = event.message;
				continue;
			}
			if (event.type === "start") {
				continue;
			}
			if (event.type === "text_delta") {
				text += event.delta;
			}
			emit({ type: "message_update", event, message: createPreview(config, text) });
		}
		assistant = terminalMessage ?? (await response.result());
	} catch (cause) {
		assistant = createFailureMessage(config, signal, cause);
	}

	messages.push(assistant);
	emit({ type: "message_end", message: assistant });
	emit({ type: "turn_end", message: assistant });
	emit({ type: "agent_end", messages });
}
