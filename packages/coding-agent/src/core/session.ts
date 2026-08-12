import { Agent, type AgentListener } from "@di-code/agent";
import type { AssistantMessage, Message, Model, Provider } from "@di-code/ai";
import { createReadTool } from "./tools/read.ts";

export interface AgentSessionOptions {
	readonly allowedRoot: string;
	readonly provider: Provider;
	readonly model: Model;
	readonly now?: () => number;
}

export class AgentSession {
	private readonly agent: Agent;

	constructor(options: AgentSessionOptions) {
		this.agent = new Agent({
			provider: options.provider,
			model: options.model,
			tools: [createReadTool(options.allowedRoot)],
			now: options.now,
		});
	}

	get transcript(): readonly Message[] {
		return this.agent.transcript;
	}

	get isStreaming(): boolean {
		return this.agent.isStreaming;
	}

	prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		return this.agent.prompt(text, signal);
	}

	subscribe(listener: AgentListener): () => void {
		return this.agent.subscribe(listener);
	}
}
