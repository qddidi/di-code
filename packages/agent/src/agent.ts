import type { AssistantMessage, Message, Model, Provider } from "@di-code/ai";
import { agentLoop } from "./agent-loop.ts";
import type { AgentContext, AgentEvent } from "./types.ts";

export interface AgentOptions {
	readonly provider: Provider;
	readonly model: Model;
	readonly systemPrompt?: string;
	readonly now?: () => number;
}

export type AgentListener = (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>;

export interface AgentState {
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

export class Agent {
	private messages: Message[] = [];
	private streaming = false;
	private readonly listeners = new Set<AgentListener>();
	private readonly provider: Provider;
	private readonly model: Model;
	private readonly systemPrompt?: string;
	private readonly now: () => number;

	constructor(options: AgentOptions) {
		this.provider = options.provider;
		this.model = options.model;
		this.systemPrompt = options.systemPrompt;
		this.now = options.now ?? Date.now;
	}

	get state(): AgentState {
		return { messages: [...this.messages], isStreaming: this.streaming };
	}

	get transcript(): readonly Message[] {
		return [...this.messages];
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	subscribe(listener: AgentListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		if (this.streaming) {
			throw new Error("Agent is already processing a prompt.");
		}

		this.streaming = true;
		const prompt = createUserMessage(text, this.now);
		const context: AgentContext = {
			systemPrompt: this.systemPrompt,
			messages: [...this.messages],
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
					listenerFailed = true;
					listenerFailure ??= cause;
				}

				if (event.type === "agent_end") {
					const candidate = event.messages.at(-1);
					if (!candidate || candidate.role !== "assistant") {
						throw new Error("agent_end did not contain an assistant message");
					}
					this.messages = [...event.messages];
					finalAssistant = candidate;
				}
			}
		} finally {
			this.streaming = false;
		}

		if (listenerFailed) throw toError(listenerFailure);
		if (!finalAssistant) throw new Error("Agent loop ended without agent_end");
		return finalAssistant;
	}

	private async notify(event: AgentEvent, signal?: AbortSignal): Promise<void> {
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
