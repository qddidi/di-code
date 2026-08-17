import type { AssistantMessage, Message, Model, Provider, UserContent } from "@di-code/ai";
import { agentLoop } from "./agent-loop.ts";
import type { AgentContext, AgentEvent, AgentTool } from "./types.ts";

export interface AgentOptions {
	readonly provider: Provider;
	readonly model: Model;
	readonly sessionId?: string;
	readonly tools?: readonly AgentTool[];
	readonly systemPrompt?: string;
	readonly now?: () => number;
	readonly initialMessages?: readonly Message[];
	readonly initialContextMessages?: readonly Message[];
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

function createUserMessage(content: readonly UserContent[], now: () => number): Extract<Message, { role: "user" }> {
	return {
		role: "user",
		content: structuredClone([...content]),
		timestamp: now(),
	};
}

/** 管理已完成的对话历史，并把单轮事件按顺序分发给订阅者。 */
export class Agent {
	// transcript 保留完整历史，context 可以由产品层替换成压缩后的模型视图。
	private transcriptMessages: Message[];
	private contextMessageState: Message[];
	private streaming = false;
	private readonly listeners = new Set<AgentListener>();
	private readonly provider: Provider;
	private model: Model;
	private readonly sessionId?: string;
	private readonly systemPrompt?: string;
	private readonly now: () => number;
	private readonly tools: readonly AgentTool[];
	constructor(options: AgentOptions) {
		this.provider = options.provider;
		this.model = options.model;
		this.sessionId = options.sessionId;
		this.tools = [...(options.tools ?? [])];
		const initialMessages = structuredClone([...(options.initialMessages ?? [])]);
		this.transcriptMessages = initialMessages;
		this.contextMessageState = structuredClone([...(options.initialContextMessages ?? initialMessages)]);
		this.systemPrompt = options.systemPrompt;
		this.now = options.now ?? Date.now;
	}

	get state(): AgentState {
		// 消息及其 content 数组都属于 Agent；深复制防止调用者改写嵌套状态。
		return { messages: structuredClone(this.transcriptMessages), isStreaming: this.streaming };
	}

	get transcript(): readonly Message[] {
		return structuredClone(this.transcriptMessages);
	}

	get contextMessages(): readonly Message[] {
		return structuredClone(this.contextMessageState);
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	setModel(model: Model): void {
		if (this.streaming) throw new Error("Cannot change Agent model while processing a prompt.");
		this.model = structuredClone(model);
	}

	replaceContext(messages: readonly Message[]): void {
		if (this.streaming) {
			throw new Error("Cannot replace Agent context while processing a prompt.");
		}
		this.contextMessageState = structuredClone([...messages]);
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
		return this.promptWithContent([{ type: "text", text }], signal);
	}

	/** Submits one user message with provider-neutral text and image content blocks. */
	async promptWithContent(content: readonly UserContent[], signal?: AbortSignal): Promise<AssistantMessage> {
		// 当前实现只有一份可提交历史，因此禁止两个轮次并发写入，避免提交顺序不确定。
		if (this.streaming) {
			throw new Error("Agent is already processing a prompt.");
		}
		if (content.length === 0) throw new Error("Agent prompt content must not be empty.");

		this.streaming = true;
		const prompt = createUserMessage(content, this.now);
		const contextLength = this.contextMessageState.length;
		const context: AgentContext = {
			systemPrompt: this.systemPrompt,
			messages: structuredClone(this.contextMessageState),
			tools: [...this.tools],
		};
		const stream = agentLoop(
			prompt,
			context,
			{ provider: this.provider, model: this.model, sessionId: this.sessionId, now: this.now },
			signal,
		);

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
					// agent_end 含旧模型 context；只把本轮新增部分追加到完整 transcript。
					const currentTurn = event.messages.slice(contextLength);
					this.transcriptMessages.push(...structuredClone(currentTurn));
					this.contextMessageState = structuredClone(event.messages);
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
			await listener(structuredClone(event), signal);
		}
	}
}
