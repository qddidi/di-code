import type { AssistantMessage, Message, Model, Provider } from "@di-code/ai";
import { agentLoop } from "./agent-loop.ts";
import type { AgentContext, AgentEvent, AgentTool } from "./types.ts";

export interface AgentOptions {
	readonly provider: Provider;
	readonly model: Model;
	readonly tools?: readonly AgentTool[];
	readonly systemPrompt?: string;
	readonly now?: () => number;
}

/** Agent 事件监听器；返回 Promise 时，后续监听器会等待它完成。 */
export type AgentListener = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;

export interface AgentState {
	/** 最近一次已完整结束的消息历史，不包含正在流式生成的中间状态。 */
	readonly messages: readonly Message[];
	readonly isStreaming: boolean;
}

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function createUserMessage(text: string, now: () => number): Extract<Message, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: now(),
	};
}

/** 管理已完成的对话历史，并把单轮事件按顺序分发给订阅者。 */
export class Agent {
	// messages 只保存已提交的轮次；本轮增量由事件流承载，直到 agent_end 才整体写入。
	private messages: Message[] = [];
	private streaming = false;
	private readonly listeners = new Set<AgentListener>();
	private readonly provider: Provider;
	private readonly model: Model;
	private readonly systemPrompt?: string;
	private readonly now: () => number;
	private readonly tools: readonly AgentTool[];
	constructor(options: AgentOptions) {
		this.provider = options.provider;
		this.model = options.model;
		this.tools = [...(options.tools ?? [])];
		this.systemPrompt = options.systemPrompt;
		this.now = options.now ?? Date.now;
	}

	get state(): AgentState {
		// 返回数组副本，防止调用者通过 state 直接增删内部消息。
		return { messages: [...this.messages], isStreaming: this.streaming };
	}

	get transcript(): readonly Message[] {
		// readonly 只约束 TypeScript 类型，复制数组才能同时建立运行时的容器边界。
		return [...this.messages];
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		// 闭包保留同一个函数引用，调用一次即可安全取消订阅。
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * 串行执行一次用户提示。模型失败与取消会返回对应的助手消息；监听器失败则拒绝此 Promise。
	 */
	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		// 当前实现只有一份可提交历史，因此禁止两个轮次并发写入，避免提交顺序不确定。
		if (this.streaming) {
			throw new Error("Agent is already processing a prompt.");
		}

		this.streaming = true;
		const prompt = createUserMessage(text, this.now);
		const context: AgentContext = {
			systemPrompt: this.systemPrompt,
			messages: [...this.messages],
			tools: [...this.tools],
		};
		const stream = agentLoop(prompt, context, { provider: this.provider, model: this.model, now: this.now }, signal);

		let finalAssistant: AssistantMessage | undefined;
		let listenerFailed = false;
		let listenerFailure: unknown;
		try {
			for await (const event of stream) {
				try {
					await this.notify(event, signal);
				} catch (cause) {
					// 监听器属于观察侧：记录首次失败，但继续排空流，确保 agent_end 仍能提交历史。
					listenerFailed = true;
					listenerFailure ??= cause;
				}

				if (event.type === "agent_end") {
					const candidate = event.messages.at(-1);
					if (!candidate || candidate.role !== "assistant") {
						throw new Error("agent_end did not contain an assistant message");
					}
					// 只在终止事件到达后原子替换历史，外部读取不会看到半个轮次。
					this.messages = [...event.messages];
					finalAssistant = candidate;
				}
			}
		} finally {
			// Provider、事件流或监听器路径无论如何结束，都必须解除并发保护。
			this.streaming = false;
		}

		// 历史提交优先完成，随后再把监听器错误反馈给 prompt 的调用者。
		if (listenerFailed) throw toError(listenerFailure);
		if (!finalAssistant) throw new Error("Agent loop ended without agent_end");
		return finalAssistant;
	}

	private async notify(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		// Set 保持注册顺序；串行 await 也为监听器提供确定性的事件处理次序。
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
