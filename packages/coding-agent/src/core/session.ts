import { randomUUID } from "node:crypto";
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
import type { AssistantMessage, ImageContent, Message, Model, Provider, Usage, UserContent } from "@di-code/ai";
import type { ExtensionHost } from "../extensions/runtime.ts";
import { buildSessionContext } from "./context-builder.ts";
import type { SkillResource } from "./resources/types.ts";
import type { SessionManager } from "./session/session-manager.ts";
import type { SessionDiagnostic } from "./session/types.ts";
import { resolveSkillCommand } from "./skill-command.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

export interface AgentSessionCompactionOptions {
	readonly enabled?: boolean;
	readonly keepRecentTokens?: number;
}

export interface SessionUsage {
	readonly requestCount: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly cost: Usage["cost"];
	readonly estimatedContextTokens: number;
	readonly contextWindow: number;
	readonly reserveTokens: number;
	readonly triggerTokens: number;
}

export interface AgentSessionOptions {
	readonly allowedRoot: string;
	readonly provider: Provider;
	readonly model: Model;
	readonly systemPrompt?: string;
	readonly skills?: readonly SkillResource[];
	readonly now?: () => number;
	readonly sessionManager?: SessionManager;
	readonly compaction?: AgentSessionCompactionOptions;
	readonly extensionHost?: ExtensionHost;
}

export type AgentSessionEvent =
	| import("@di-code/agent").AgentEvent
	| { type: "compaction_start"; reason: "threshold" | "manual" }
	| { type: "compaction_end"; reason: "threshold" | "manual"; success: boolean; errorMessage?: string }
	| { type: "usage_update"; usage: SessionUsage };

export type AgentSessionListener = (event: AgentSessionEvent) => void | Promise<void>;

export class AgentSession {
	private readonly agent: Agent;
	private readonly allowedRootValue: string;
	private readonly sessionManager?: SessionManager;
	private readonly provider: Provider;
	private readonly skills: readonly SkillResource[];
	private readonly extensionHost?: ExtensionHost;
	private model: Model;
	private readonly sessionIdValue: string;
	private readonly now: () => number;
	private compactionEnabledValue: boolean;
	private contextBudget: ContextBudget;
	private keepRecentTokens: number;
	private usageTotals: Omit<
		SessionUsage,
		"estimatedContextTokens" | "contextWindow" | "reserveTokens" | "triggerTokens"
	>;
	private persistenceError?: unknown;
	private promptActive = false;
	private readonly sessionListeners = new Set<AgentSessionListener>();

	constructor(options: AgentSessionOptions) {
		this.allowedRootValue = options.allowedRoot;
		this.sessionManager = options.sessionManager;
		this.provider = options.provider;
		this.skills = structuredClone([...(options.skills ?? [])]);
		this.extensionHost = options.extensionHost;
		this.model = options.model;
		this.sessionIdValue = options.sessionManager?.header.id ?? randomUUID();
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
		this.usageTotals = {
			requestCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const message of options.sessionManager?.messages ?? []) {
			if (message.role === "assistant") this.addUsage(message.usage);
		}
		const initialContext = options.sessionManager ? buildSessionContext(options.sessionManager.entries) : undefined;
		this.agent = new Agent({
			provider: options.provider,
			model: options.model,
			systemPrompt: options.systemPrompt,
			sessionId: this.sessionIdValue,
			tools: [
				createReadTool(options.allowedRoot),
				createWriteTool(options.allowedRoot),
				createEditTool(options.allowedRoot),
				createBashTool(options.allowedRoot),
				...(this.extensionHost?.listTools().map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					execute: async (toolCallId: string, parameters: never, signal?: AbortSignal) => {
						const result = await this.extensionHost?.runTool(tool.name, toolCallId, parameters, signal);
						if (result === undefined) throw new Error(`Extension tool "${tool.name}" is unavailable.`);
						return [...result];
					},
				})) ?? []),
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
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			this.addUsage(event.message.usage);
			await this.emitSession({ type: "usage_update", usage: this.usage });
		});
		this.agent.subscribe(async (event, signal) => {
			if (this.extensionHost) await this.extensionHost.emit(event, signal);
			await this.emitSession(event);
		});
	}

	get transcript(): readonly Message[] {
		return this.agent.transcript;
	}

	get isStreaming(): boolean {
		return this.promptActive;
	}

	get sessionId(): string {
		return this.sessionIdValue;
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

	get availableSkills(): readonly SkillResource[] {
		return structuredClone(this.skills);
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

	get usage(): SessionUsage {
		return {
			...this.usageTotals,
			cost: { ...this.usageTotals.cost },
			estimatedContextTokens: estimateContextTokens(this.agent.contextMessages),
			contextWindow: this.contextBudget.contextWindow,
			reserveTokens: this.contextBudget.reserveTokens,
			triggerTokens: this.contextBudget.triggerTokens,
		};
	}

	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		return this.promptWithImages(text, [], signal);
	}

	/** Sends one text prompt with explicitly supplied image attachments. */
	async promptWithImages(
		text: string,
		images: readonly ImageContent[],
		signal?: AbortSignal,
	): Promise<AssistantMessage> {
		if (this.persistenceError !== undefined) {
			throw this.persistenceError;
		}
		if (this.promptActive) {
			throw new Error("AgentSession is already processing a prompt.");
		}

		this.promptActive = true;
		try {
			if (images.length > 0 && !this.model.input.includes("image")) {
				throw new Error(`Model "${this.model.id}" does not support image input.`);
			}
			const prompt = await resolveSkillCommand(text, this.skills, signal);
			const content: UserContent[] = [{ type: "text", text: prompt }, ...structuredClone([...images])];
			await this.compactIfNeeded(content, signal);
			return await this.agent.promptWithContent(content, signal);
		} finally {
			this.promptActive = false;
		}
	}

	async compact(signal?: AbortSignal): Promise<void> {
		if (this.promptActive) throw new Error("AgentSession is already processing a prompt.");
		if (!this.sessionManager) throw new Error("Cannot compact without a persisted session.");
		this.promptActive = true;
		try {
			await this.compactNow(signal, "manual");
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

	private addUsage(usage: Usage): void {
		this.usageTotals = {
			requestCount: this.usageTotals.requestCount + 1,
			inputTokens: this.usageTotals.inputTokens + usage.input,
			outputTokens: this.usageTotals.outputTokens + usage.output,
			cacheReadTokens: this.usageTotals.cacheReadTokens + usage.cacheRead,
			cacheWriteTokens: this.usageTotals.cacheWriteTokens + usage.cacheWrite,
			totalTokens: this.usageTotals.totalTokens + usage.totalTokens,
			cost: {
				input: this.usageTotals.cost.input + usage.cost.input,
				output: this.usageTotals.cost.output + usage.cost.output,
				cacheRead: this.usageTotals.cost.cacheRead + usage.cost.cacheRead,
				cacheWrite: this.usageTotals.cost.cacheWrite + usage.cost.cacheWrite,
				total: this.usageTotals.cost.total + usage.cost.total,
			},
		};
	}

	private async compactIfNeeded(content: readonly UserContent[], signal?: AbortSignal): Promise<void> {
		if (!this.compactionEnabledValue || !this.sessionManager) return;

		const context = buildSessionContext(this.sessionManager.entries);
		const pendingUser: Message = {
			role: "user",
			content: structuredClone([...content]),
			timestamp: 0,
		};
		const estimatedTokens = estimateContextTokens([...context.messages, pendingUser]);
		if (!shouldCompact(estimatedTokens, this.contextBudget)) return;

		await this.compactNow(signal, "threshold");
	}

	private async compactNow(signal: AbortSignal | undefined, reason: "threshold" | "manual"): Promise<void> {
		if (!this.sessionManager) throw new Error("Cannot compact without a persisted session.");
		const context = buildSessionContext(this.sessionManager.entries);
		await this.emitSession({ type: "compaction_start", reason });
		const preparation = prepareCompaction(context.messages, this.keepRecentTokens);
		const firstKeptEntryId = preparation ? context.sourceEntryIds[preparation.firstKeptMessageIndex] : undefined;
		if (!preparation || typeof firstKeptEntryId !== "string") {
			const errorMessage =
				reason === "manual"
					? "No valid compaction cut point was found for the current session."
					: "Context limit reached but no valid compaction cut point was found.";
			await this.emitSession({ type: "compaction_end", reason, success: false, errorMessage });
			throw new Error(errorMessage);
		}

		let summary: string;
		try {
			summary = await generateCompactionSummary(preparation, this.provider, this.model, {
				reserveTokens: this.contextBudget.reserveTokens,
				signal,
				now: this.now,
				onUsage: (usage) => this.addUsage(usage),
			});
			await this.emitSession({ type: "usage_update", usage: this.usage });
		} catch (cause) {
			const errorMessage = cause instanceof Error ? cause.message : String(cause);
			await this.emitSession({ type: "compaction_end", reason, success: false, errorMessage });
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
			await this.emitSession({ type: "compaction_end", reason, success: false, errorMessage });
			throw cause;
		}

		this.agent.replaceContext(buildSessionContext(this.sessionManager.entries).messages);
		await this.emitSession({ type: "compaction_end", reason, success: true });
	}
}
