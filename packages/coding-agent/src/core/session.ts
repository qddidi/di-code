import {
	Agent,
	type AgentListener,
	type ContextBudget,
	estimateContextTokens,
	generateCompactionSummary,
	prepareCompaction,
	resolveContextBudget,
	shouldCompact,
} from "@di-code/agent";
import type { AssistantMessage, Message, Model, Provider } from "@di-code/ai";
import { buildSessionContext } from "./context-builder.ts";
import type { SessionManager } from "./session/session-manager.ts";
import type { SessionDiagnostic } from "./session/types.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

export interface AgentSessionCompactionOptions {
	readonly enabled?: boolean;
	readonly keepRecentTokens?: number;
}

export interface AgentSessionOptions {
	readonly allowedRoot: string;
	readonly provider: Provider;
	readonly model: Model;
	readonly now?: () => number;
	readonly sessionManager?: SessionManager;
	readonly compaction?: AgentSessionCompactionOptions;
}

export type AgentSessionEvent =
	| import("@di-code/agent").AgentEvent
	| { type: "compaction_start"; reason: "threshold" }
	| { type: "compaction_end"; reason: "threshold"; success: boolean; errorMessage?: string };

export type AgentSessionListener = (event: AgentSessionEvent) => void | Promise<void>;

export class AgentSession {
	private readonly agent: Agent;
	private readonly allowedRootValue: string;
	private readonly sessionManager?: SessionManager;
	private readonly provider: Provider;
	private model: Model;
	private readonly now: () => number;
	private compactionEnabledValue: boolean;
	private contextBudget: ContextBudget;
	private keepRecentTokens: number;
	private persistenceError?: unknown;
	private promptActive = false;
	private readonly sessionListeners = new Set<AgentSessionListener>();

	constructor(options: AgentSessionOptions) {
		this.allowedRootValue = options.allowedRoot;
		this.sessionManager = options.sessionManager;
		this.provider = options.provider;
		this.model = options.model;
		this.now = options.now ?? Date.now;
		this.contextBudget = resolveContextBudget(options.model);
		if (options.compaction?.enabled !== undefined && typeof options.compaction.enabled !== "boolean") {
			throw new TypeError("compaction.enabled must be a boolean");
		}
		this.compactionEnabledValue = options.sessionManager !== undefined && options.compaction?.enabled !== false;
		const defaultKeepRecentTokens = Math.max(1, Math.min(20_000, Math.floor(this.contextBudget.triggerTokens / 2)));
		this.keepRecentTokens = options.compaction?.keepRecentTokens ?? defaultKeepRecentTokens;
		if (!Number.isInteger(this.keepRecentTokens) || this.keepRecentTokens <= 0) {
			throw new RangeError("compaction.keepRecentTokens must be a positive integer");
		}
		const initialContext = options.sessionManager ? buildSessionContext(options.sessionManager.entries) : undefined;
		this.agent = new Agent({
			provider: options.provider,
			model: options.model,
			tools: [
				createReadTool(options.allowedRoot),
				createWriteTool(options.allowedRoot),
				createEditTool(options.allowedRoot),
				createBashTool(options.allowedRoot),
			],
			now: this.now,
			initialMessages: options.sessionManager?.messages,
			initialContextMessages: initialContext?.messages,
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
		this.agent.subscribe(async (event) => {
			await this.emitSession(event);
		});
	}

	get transcript(): readonly Message[] {
		return this.agent.transcript;
	}

	get isStreaming(): boolean {
		return this.promptActive;
	}

	get modelId(): string {
		return this.model.id;
	}

	get allowedRoot(): string {
		return this.allowedRootValue;
	}

	get availableModels(): readonly Model[] {
		return structuredClone(this.provider.models);
	}

	setModel(modelId: string): Model {
		if (this.promptActive) throw new Error("Cannot change model while AgentSession is processing a prompt.");
		const next = this.provider.models.find((model) => model.id === modelId);
		if (!next) throw new Error(`Unknown model "${modelId}" for provider "${this.provider.id}".`);
		this.model = structuredClone(next);
		this.agent.setModel(this.model);
		this.contextBudget = resolveContextBudget(this.model);
		this.keepRecentTokens = Math.min(
			this.keepRecentTokens,
			Math.max(1, Math.min(20_000, Math.floor(this.contextBudget.triggerTokens / 2))),
		);
		return structuredClone(this.model);
	}

	get compactionEnabled(): boolean {
		return this.compactionEnabledValue;
	}

	setCompactionEnabled(enabled: boolean): boolean {
		if (this.promptActive) throw new Error("Cannot change compaction while AgentSession is processing a prompt.");
		this.compactionEnabledValue = enabled && this.sessionManager !== undefined;
		return this.compactionEnabledValue;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager?.filePath;
	}

	get sessionDiagnostics(): readonly SessionDiagnostic[] {
		return this.sessionManager?.diagnostics ?? [];
	}

	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		if (this.persistenceError !== undefined) {
			throw this.persistenceError;
		}
		if (this.promptActive) {
			throw new Error("AgentSession is already processing a prompt.");
		}

		this.promptActive = true;
		try {
			await this.compactIfNeeded(text, signal);
			return await this.agent.prompt(text, signal);
		} finally {
			this.promptActive = false;
		}
	}

	subscribe(listener: AgentListener): () => void {
		return this.agent.subscribe(listener);
	}

	subscribeSession(listener: AgentSessionListener): () => void {
		this.sessionListeners.add(listener);
		return () => this.sessionListeners.delete(listener);
	}

	private async emitSession(event: AgentSessionEvent): Promise<void> {
		for (const listener of this.sessionListeners) await listener(structuredClone(event));
	}

	private async compactIfNeeded(text: string, signal?: AbortSignal): Promise<void> {
		if (!this.compactionEnabledValue || !this.sessionManager) return;

		const context = buildSessionContext(this.sessionManager.entries);
		const pendingUser: Message = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 0,
		};
		const estimatedTokens = estimateContextTokens([...context.messages, pendingUser]);
		if (!shouldCompact(estimatedTokens, this.contextBudget)) return;

		await this.emitSession({ type: "compaction_start", reason: "threshold" });
		const preparation = prepareCompaction(context.messages, this.keepRecentTokens);
		const firstKeptEntryId = preparation ? context.sourceEntryIds[preparation.firstKeptMessageIndex] : undefined;
		if (!preparation || typeof firstKeptEntryId !== "string") {
			const errorMessage = "Context limit reached but no valid compaction cut point was found.";
			await this.emitSession({ type: "compaction_end", reason: "threshold", success: false, errorMessage });
			throw new Error(errorMessage);
		}

		let summary: string;
		try {
			summary = await generateCompactionSummary(preparation, this.provider, this.model, {
				reserveTokens: this.contextBudget.reserveTokens,
				signal,
				now: this.now,
			});
		} catch (cause) {
			const errorMessage = cause instanceof Error ? cause.message : String(cause);
			await this.emitSession({ type: "compaction_end", reason: "threshold", success: false, errorMessage });
			throw cause;
		}

		try {
			await this.sessionManager.appendSummary({
				summary,
				firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			});
		} catch (cause) {
			this.persistenceError = cause;
			const errorMessage = cause instanceof Error ? cause.message : String(cause);
			await this.emitSession({ type: "compaction_end", reason: "threshold", success: false, errorMessage });
			throw cause;
		}

		this.agent.replaceContext(buildSessionContext(this.sessionManager.entries).messages);
		await this.emitSession({ type: "compaction_end", reason: "threshold", success: true });
	}
}
