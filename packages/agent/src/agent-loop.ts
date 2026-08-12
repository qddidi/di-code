import { type AssistantMessage, EventStream, type Message, type UserMessage } from "@di-code/ai";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessagePreview } from "./types.ts";

/**
 * 执行一个用户提示对应的模型轮次，并按生命周期顺序返回 Agent 事件流。
 * 流以 agent_end 结束，其 result() 是包含本轮用户与助手消息的完整历史。
 */
export function agentLoop(
	prompt: UserMessage,
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
): EventStream<AgentEvent, Message[]> {
	const stream = createAgentEventStream();
	// 先把事件流交给调用者，再在微任务中启动生产端，使调用者能立即开始消费事件。
	queueMicrotask(() => {
		void runAgentLoop(prompt, context, config, signal, stream);
	});
	return stream;
}

function createAgentEventStream(): EventStream<AgentEvent, Message[]> {
	return new EventStream<AgentEvent, Message[]>({
		validate() {},
		// agent_end 同时关闭异步迭代器，并把完整消息历史解析为流的最终结果。
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
	// Provider 在取消时可能直接抛错；此处依据 signal 将它归一化为 aborted，而不是普通 error。
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
	// 在副本上构建本轮历史，避免流尚未结束时提前修改调用者持有的上下文。
	const messages: Message[] = [...context.messages, prompt];
	const emit = (event: AgentEvent): void => stream.push(event);

	// 用户消息已经完整存在，因此只需要发出开始和结束事件；助手消息则会在后面流式更新。
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
			// done/error 携带 Provider 构造的权威最终消息，不再作为普通增量向外转发。
			if (event.type === "done" || event.type === "error") {
				terminalMessage = event.message;
				continue;
			}
			// Agent 层已经发出了自己的 message_start，Provider 的 start 事件无需重复暴露。
			if (event.type === "start") {
				continue;
			}
			if (event.type === "text_delta") {
				text += event.delta;
			}
			// 原始增量保留具体事件信息，preview 则提供截至当前时刻的可直接展示文本。
			emit({ type: "message_update", event, message: createPreview(config, text) });
		}
		// 正常情况下终止事件已经给出消息；result() 是流结束但未观察到终止事件时的兜底。
		assistant = terminalMessage ?? (await response.result());
	} catch (cause) {
		// 无论 Provider 是同步抛错还是迭代中失败，都结束为一个结构化助手消息，保持生命周期闭合。
		assistant = createFailureMessage(config, signal, cause);
	}

	// agent_end 是唯一终止事件；消费者可在这里一次性提交完整且自洽的消息历史。
	messages.push(assistant);
	emit({ type: "message_end", message: assistant });
	emit({ type: "turn_end", message: assistant });
	emit({ type: "agent_end", messages });
}
