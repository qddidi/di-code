import { Agent, type AgentListener } from "@di-code/agent";
import type { AssistantMessage, Message, Model, Provider } from "@di-code/ai";
import type { SessionManager } from "./session/session-manager.ts";
import type { SessionDiagnostic } from "./session/types.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

export interface AgentSessionOptions {
	readonly allowedRoot: string;
	readonly provider: Provider;
	readonly model: Model;
	readonly now?: () => number;
	readonly sessionManager?: SessionManager;
}

export class AgentSession {
	private readonly agent: Agent;
	private readonly sessionManager?: SessionManager;
	private persistenceError?: unknown;

	constructor(options: AgentSessionOptions) {
		this.sessionManager = options.sessionManager;
		this.agent = new Agent({
			provider: options.provider,
			model: options.model,
			tools: [
				createReadTool(options.allowedRoot),
				createWriteTool(options.allowedRoot),
				createEditTool(options.allowedRoot),
				createBashTool(options.allowedRoot),
			],
			now: options.now,
			initialMessages: options.sessionManager?.messages,
		});
		this.agent.subscribe(async (event) => {
			if (event.type !== "message_end" || this.sessionManager === undefined || this.persistenceError !== undefined) {
				return;
			}
			try {
				await this.sessionManager.appendMessage(event.message);
			} catch (cause) {
				this.persistenceError = cause;
				throw cause;
			}
		});
	}

	get transcript(): readonly Message[] {
		return this.agent.transcript;
	}

	get isStreaming(): boolean {
		return this.agent.isStreaming;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager?.filePath;
	}

	get sessionDiagnostics(): readonly SessionDiagnostic[] {
		return this.sessionManager?.diagnostics ?? [];
	}

	prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		if (this.persistenceError !== undefined) {
			return Promise.reject(this.persistenceError);
		}
		return this.agent.prompt(text, signal);
	}

	subscribe(listener: AgentListener): () => void {
		return this.agent.subscribe(listener);
	}
}
