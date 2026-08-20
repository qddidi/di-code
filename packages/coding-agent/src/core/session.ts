import { randomUUID } from "node:crypto";
import type { AgentTool } from "@di-code/agent";
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
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	Provider,
	ThinkingLevel,
	Usage,
	UserContent,
} from "@di-code/ai";
import { createSkillCatalog, resolveSkillInvocation, type SkillCatalog } from "@di-code/skills";
import type { ExtensionHost } from "../extensions/runtime.ts";
import type { CodingAgentPluginHost } from "../plugins/runtime-host.ts";
import { type SubagentEvent, SubagentService } from "../subagents/service.ts";
import type { SkillResource } from "./resources/types.ts";
import type { SessionManager } from "./session/session-manager.ts";
import type { SessionDiagnostic, SessionEntry, SessionTreeNode } from "./session/types.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createGlobTool } from "./tools/glob.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLoadSkillTool } from "./tools/load-skill.ts";
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
	/** Valid initial override for the selected model's thinking level. */
	readonly thinkingLevel?: ThinkingLevel;
	readonly systemPrompt?: string;
	readonly skills?: readonly SkillResource[];
	readonly now?: () => number;
	readonly sessionManager?: SessionManager;
	readonly compaction?: AgentSessionCompactionOptions;
	readonly extensionHost?: ExtensionHost;
	readonly runtimePluginHost?: CodingAgentPluginHost;
	readonly subagentDepth?: number;
	readonly subagents?:
		| false
		| {
				readonly maxDepth?: number;
				readonly maxConcurrent?: number;
				readonly timeoutMs?: number;
				readonly maxResultBytes?: number;
		  };
	/** External tools already validated by the product integration layer. */
	readonly externalTools?: readonly AgentTool[];
}

export type AgentSessionEvent =
	| import("@di-code/agent").AgentEvent
	| { type: "compaction_start"; reason: "threshold" | "manual" }
	| { type: "compaction_end"; reason: "threshold" | "manual"; success: boolean; errorMessage?: string }
	| { type: "queue_update"; steering: readonly string[] }
	| { type: "usage_update"; usage: SessionUsage }
	| {
			type: "tree_navigated";
			oldLeafId: string;
			newLeafId: string;
			selectedEntryId: string;
			restoredEditorText: boolean;
	  }
	| SubagentEvent;

export interface TreeNavigationResult {
	readonly editorText?: string;
	readonly selectedEntryId: string;
	readonly leafId: string;
	readonly imagesOmitted: boolean;
}

export type AgentSessionListener = (event: AgentSessionEvent) => void | Promise<void>;

function defaultThinkingLevel(model: Model): ThinkingLevel | undefined {
	const efforts = model.reasoningEfforts;
	if (!efforts || efforts.length === 0) return undefined;
	return (
		model.defaultReasoningEffort ??
		(efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0])
	);
}

function textFromUserMessage(message: Extract<Message, { role: "user" }>): string {
	return message.content
		.filter((content): content is Extract<UserContent, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("");
}

export class AgentSession {
	private readonly agent: Agent;
	private readonly allowedRootValue: string;
	private readonly sessionManager?: SessionManager;
	private provider: Provider;
	private readonly skills: readonly SkillResource[];
	private readonly skillCatalog: SkillCatalog;
	private readonly extensionHost?: ExtensionHost;
	private readonly runtimePluginHost?: CodingAgentPluginHost;
	private readonly subagentService?: SubagentService;
	private model: Model;
	private thinkingLevelValue?: ThinkingLevel;
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
	private readonly steeringMessages: Array<{ displayText: string; deliveredText: string }> = [];
	private readonly sessionListeners = new Set<AgentSessionListener>();

	constructor(options: AgentSessionOptions) {
		this.allowedRootValue = options.allowedRoot;
		this.sessionManager = options.sessionManager;
		this.provider = options.provider;
		this.skills = structuredClone(
			[...(options.skills ?? [])].map((skill) => ({
				...skill,
				source:
					skill.source ?? (skill.scope === "explicit" ? "explicit" : skill.scope === "project" ? "project" : "user"),
				userInvocable: skill.userInvocable ?? true,
			})),
		);
		this.skillCatalog = createSkillCatalog(
			this.skills.map((skill) => ({
				skill: {
					...skill,
					source:
						skill.source ?? (skill.scope === "explicit" ? "explicit" : skill.scope === "project" ? "project" : "user"),
					userInvocable: skill.userInvocable ?? true,
				},
				diagnostics: [],
			})),
		);
		this.extensionHost = options.extensionHost;
		this.runtimePluginHost = options.runtimePluginHost;
		this.model = options.model;
		this.thinkingLevelValue =
			options.thinkingLevel !== undefined && this.model.reasoningEfforts?.includes(options.thinkingLevel)
				? options.thinkingLevel
				: defaultThinkingLevel(this.model);
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
		const initialContext = options.sessionManager?.buildContext();
		const staticTools: AgentTool<import("@di-code/ai").TSchema, import("@di-code/agent").AgentToolResult>[] = [
			createReadTool(options.allowedRoot),
			createWriteTool(options.allowedRoot),
			createEditTool(options.allowedRoot),
			createBashTool(options.allowedRoot),
			createGlobTool(options.allowedRoot),
			createGrepTool(options.allowedRoot),
			...(this.skillCatalog.listForModel().length > 0 ? [createLoadSkillTool(this.skillCatalog)] : []),
			...(this.extensionHost
				?.listTools()
				.filter((tool) => !this.runtimePluginHost?.listTools().some((runtimeTool) => runtimeTool.name === tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					execute: async (toolCallId: string, parameters: never, signal?: AbortSignal) => {
						const result = await this.extensionHost?.runTool(tool.name, toolCallId, parameters, signal);
						if (result === undefined) throw new Error(`Extension tool "${tool.name}" is unavailable.`);
						return [...result];
					},
				})) ?? []),
			...(options.externalTools ?? []),
		];
		if (options.subagents !== false) {
			this.subagentService = new SubagentService({
				parentSessionId: this.sessionIdValue,
				cwd: this.allowedRootValue,
				provider: options.provider,
				model: options.model,
				currentDepth: options.subagentDepth ?? 0,
				providers: this.runtimePluginHost?.snapshot().contributions.subagentProviders,
				toolNames: staticTools.map((tool) => tool.name),
				pluginIds: this.runtimePluginHost?.listPluginIds(),
				maxDepth: options.subagents?.maxDepth,
				maxConcurrent: options.subagents?.maxConcurrent,
				defaultTimeoutMs: options.subagents?.timeoutMs,
				maxResultBytes: options.subagents?.maxResultBytes,
					emit: async (event) => {
						if (this.sessionManager) {
							await this.sessionManager.appendSubagent({
								runId: event.runId,
								event:
									event.type === "subagent_start"
										? "start"
										: event.type === "subagent_end"
											? "end"
											: "update",
							status: event.status,
							...(event.text === undefined ? {} : { text: event.text }),
							...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
						});
					}
					await this.emitSession(event);
				},
				createSession: (request) =>
					new AgentSession({
						...options,
						sessionManager: undefined,
						subagentDepth: request.depth,
						subagents: options.subagents,
					}),
			});
			staticTools.push(...this.subagentService.createTools());
		}
		this.agent = new Agent({
			provider: options.provider,
			model: options.model,
			thinkingLevel: this.thinkingLevelValue,
			systemPrompt: options.systemPrompt,
			contextProvider: this.runtimePluginHost?.getContextProvider({
				systemPrompt: options.systemPrompt,
				tools: staticTools,
			}),
			sessionId: this.sessionIdValue,
			tools: staticTools,
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
			if (event.type === "message_end" && event.message.role === "user") {
				const queued = this.steeringMessages[0];
				if (queued && textFromUserMessage(event.message) === queued.deliveredText) {
					this.steeringMessages.shift();
					await this.emitQueueUpdate();
				}
			}
			if (this.extensionHost) await this.extensionHost.emit(event, signal);
			if (this.runtimePluginHost) await this.runtimePluginHost.emit(event, signal);
			await this.emitSession(event);
		});
	}

	get transcript(): readonly Message[] {
		if (!this.sessionManager) return this.agent.transcript;
		return this.sessionManager
			.getBranch()
			.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
			.map((entry) => structuredClone(entry.message));
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

	get providerId(): string {
		return this.provider.id;
	}

	get thinkingLevel(): ThinkingLevel | undefined {
		return this.thinkingLevelValue;
	}

	get allowedRoot(): string {
		return this.allowedRootValue;
	}

	get availableModels(): readonly Model[] {
		return structuredClone(this.provider.models);
	}

	get availableSkills(): readonly SkillResource[] {
		return structuredClone(this.skills.filter((skill) => skill.userInvocable !== false));
	}

	setModel(modelId: string): Model {
		if (this.promptActive) throw new Error("Cannot change model while AgentSession is processing a prompt.");
		const next = this.provider.models.find((model) => model.id === modelId);
		if (!next) throw new Error(`Unknown model "${modelId}" for provider "${this.provider.id}".`);
		this.model = structuredClone(next);
		this.thinkingLevelValue =
			this.thinkingLevelValue !== undefined && this.model.reasoningEfforts?.includes(this.thinkingLevelValue)
				? this.thinkingLevelValue
				: defaultThinkingLevel(this.model);
		this.agent.setModel(this.model);
		this.agent.setThinkingLevel(this.thinkingLevelValue);
		this.contextBudget = resolveContextBudget(this.model);
		this.keepRecentTokens = Math.min(
			this.keepRecentTokens,
			Math.max(1, Math.min(20_000, Math.floor(this.contextBudget.triggerTokens / 2))),
		);
		return structuredClone(this.model);
	}

	setRuntime(provider: Provider, model: Model): Model {
		if (this.promptActive) throw new Error("Cannot change runtime while AgentSession is processing a prompt.");
		const configuredModel = provider.models.find((candidate) => candidate.id === model.id);
		if (!configuredModel || configuredModel.provider !== provider.id || model.provider !== provider.id) {
			throw new Error(`Model "${model.id}" does not belong to provider "${provider.id}".`);
		}
		this.provider = provider;
		this.model = structuredClone(configuredModel);
		this.thinkingLevelValue = defaultThinkingLevel(this.model);
		this.agent.setRuntime(provider, this.model);
		this.agent.setThinkingLevel(this.thinkingLevelValue);
		this.contextBudget = resolveContextBudget(this.model);
		this.keepRecentTokens = Math.min(
			this.keepRecentTokens,
			Math.max(1, Math.min(20_000, Math.floor(this.contextBudget.triggerTokens / 2))),
		);
		return structuredClone(this.model);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (this.promptActive) throw new Error("Cannot change thinking level while AgentSession is processing a prompt.");
		const efforts = this.model.reasoningEfforts;
		if (!efforts || efforts.length === 0) return undefined;
		const currentIndex = this.thinkingLevelValue === undefined ? -1 : efforts.indexOf(this.thinkingLevelValue);
		this.thinkingLevelValue = efforts[(currentIndex + 1) % efforts.length];
		this.agent.setThinkingLevel(this.thinkingLevelValue);
		return this.thinkingLevelValue;
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

	/** Projects host-owned plugin state without writing arbitrary plugin data to Session JSONL. */
	async projectPluginState(value: unknown): Promise<Readonly<Record<string, import("@di-code/ai").JsonValue>>> {
		return (await this.runtimePluginHost?.projectSession(value)) ?? {};
	}

	get subagents(): SubagentService | undefined {
		return this.subagentService;
	}

	async disposeSubagents(): Promise<void> {
		await this.subagentService?.dispose();
	}

	get sessionDiagnostics(): readonly SessionDiagnostic[] {
		return this.sessionManager?.diagnostics ?? [];
	}

	get sessionTree(): readonly SessionTreeNode[] {
		return this.sessionManager?.getTree() ?? [];
	}

	get sessionLeafId(): string | undefined {
		return this.sessionManager?.leafId;
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

	/** Queues an instruction for the next provider request while this Session is running. */
	async steer(text: string, signal?: AbortSignal): Promise<void> {
		await this.steerWithImages(text, [], signal);
	}

	/** Queues provider-neutral text and image content for the active Agent run. */
	async steerWithImages(text: string, images: readonly ImageContent[], signal?: AbortSignal): Promise<void> {
		if (this.persistenceError !== undefined) throw this.persistenceError;
		if (!this.promptActive) throw new Error("AgentSession is not processing a prompt.");
		if (images.length > 0 && !this.model.input.includes("image")) {
			throw new Error(`Model "${this.model.id}" does not support image input.`);
		}
		const prompt = await resolveSkillInvocation(text, this.skillCatalog, signal);
		const content: UserContent[] = [{ type: "text", text: prompt }, ...structuredClone([...images])];
		this.agent.steerWithContent(content);
		this.steeringMessages.push({ displayText: text, deliveredText: prompt });
		await this.emitQueueUpdate();
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
			const prompt = await resolveSkillInvocation(text, this.skillCatalog, signal);
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

	/** Changes the active persisted branch and replaces the next-request model context. */
	async navigateTree(entryId: string): Promise<TreeNavigationResult> {
		if (this.promptActive)
			throw new Error("Cannot navigate the session tree while AgentSession is processing a prompt.");
		if (!this.sessionManager) throw new Error("Cannot navigate an in-memory session.");
		const entry = this.sessionManager.getEntry(entryId);
		if (!entry) throw new Error(`Unknown session tree entry "${entryId}".`);
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "tool_use") {
			throw new Error("Select the final tool result for an assistant message with tool calls.");
		}

		const oldLeafId = this.sessionManager.leafId;
		let editorText: string | undefined;
		let imagesOmitted = false;
		if (entry.type === "message" && entry.message.role === "user") {
			editorText = textFromUserMessage(entry.message);
			imagesOmitted = entry.message.content.some((content) => content.type === "image");
			this.sessionManager.setLeaf(entry.parentId);
		} else {
			this.sessionManager.setLeaf(entry.id);
		}

		try {
			this.agent.replaceContext(this.sessionManager.buildContext().messages);
		} catch (cause) {
			this.sessionManager.setLeaf(oldLeafId);
			throw cause;
		}
		await this.emitSession({
			type: "tree_navigated",
			oldLeafId,
			newLeafId: this.sessionManager.leafId,
			selectedEntryId: entry.id,
			restoredEditorText: editorText !== undefined,
		});
		return { editorText, selectedEntryId: entry.id, leafId: this.sessionManager.leafId, imagesOmitted };
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

	private async emitQueueUpdate(): Promise<void> {
		await this.emitSession({
			type: "queue_update",
			steering: this.steeringMessages.map((message) => message.displayText),
		});
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

		const context = this.sessionManager.buildContext();
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
		const context = this.sessionManager.buildContext();
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

		this.agent.replaceContext(this.sessionManager.buildContext().messages);
		await this.emitSession({ type: "compaction_end", reason, success: true });
	}
}
