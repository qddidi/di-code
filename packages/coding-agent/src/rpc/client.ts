import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AssistantMessage, Model, ThinkingLevel } from "@di-code/ai";
import type { UserInteractionResult } from "@di-code/plugin-sdk";
import { JsonlLineDecoder, serializeJsonLine } from "./jsonl.ts";
import {
	type OperationState,
	parseRpcServerMessage,
	RPC_PROTOCOL_VERSION,
	type RpcAttachmentInfo,
	type RpcCapabilities,
	type RpcContextFileInfo,
	type RpcErrorCode,
	type RpcEventRecord,
	type RpcMcpServerInfo,
	type RpcMethod,
	type RpcProductState,
	type RpcProviderSummary,
	type RpcRequest,
	type RpcSessionState,
	type RpcSettingsSnapshot,
	type RpcSuccessResult,
} from "./protocol.ts";

export interface RpcTransport {
	readonly readable: Readable;
	readonly writable: Writable;
	onExit?(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
	close?(): void;
}

export interface RpcPromptOptions {
	/** Explicit session ownership; required by the v1 session-scoped protocol. */
	readonly sessionId?: string;
	/** Required for steer/cancel/approval operations. */
	readonly runId?: string;
	readonly signal?: AbortSignal;
	/** Attachments are uploaded explicitly and consumed by this request; requests are never replayed automatically. */
	readonly attachmentIds?: readonly string[];
}

export interface RpcSessionInfo {
	readonly id: string;
	readonly label: string;
	readonly modifiedAt?: number;
}

export interface RpcRuntimeSnapshot {
	readonly providerId: string;
	readonly modelId: string;
	readonly thinkingLevel?: ThinkingLevel;
}

interface PendingRequest {
	readonly method: RpcMethod;
	readonly resolve: (result: RpcSuccessResult) => void;
	readonly reject: (error: Error) => void;
}

export class RpcRemoteError extends Error {
	readonly code: RpcErrorCode;

	constructor(code: RpcErrorCode, message: string) {
		super(message);
		this.name = "RpcRemoteError";
		this.code = code;
	}
}

export class RpcClient {
	private readonly transport: RpcTransport;
	private readonly decoder: JsonlLineDecoder;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: RpcEventRecord) => void>();
	private readonly removeExitListener?: () => void;
	private sessionId: string | undefined;
	private closed = false;

	constructor(transport: RpcTransport) {
		this.transport = transport;
		this.decoder = new JsonlLineDecoder((line) => this.acceptLine(line));
		transport.readable.on("data", this.handleData);
		transport.readable.once("end", this.handleEnd);
		transport.readable.once("error", this.handleError);
		transport.writable.once("error", this.handleError);
		this.removeExitListener = transport.onExit?.((code, signal) => {
			this.fail(new RpcRemoteError("PROCESS_EXIT", `RPC process exited (code=${code} signal=${signal})`));
		});
	}

	subscribe(listener: (event: RpcEventRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getState(): Promise<RpcSessionState> {
		const result = await this.send("get_state", {});
		if (result.method !== "get_state") throw new Error("RPC get_state returned an incompatible result.");
		const state = result.state as RpcSessionState;
		this.sessionId = state.sessionId === "uninitialized" ? undefined : state.sessionId;
		return state;
	}

	async prompt(message: string, options: RpcPromptOptions = {}): Promise<AssistantMessage> {
		const sessionId = options.sessionId ?? this.sessionId ?? (await this.getState()).sessionId;
		const requestId = randomUUID();
		const onAbort = () => {
			void this.cancel(requestId).catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = this.send(
				"prompt",
				{
					sessionId,
					message,
					...(options.attachmentIds === undefined ? {} : { attachmentIds: [...options.attachmentIds] }),
				},
				requestId,
			);
			if (options.signal?.aborted) onAbort();
			const result = await response;
			if (result.method !== "prompt") throw new Error("RPC prompt returned an incompatible result.");
			return result.message as AssistantMessage;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Starts a prompt with an explicit session target and returns the final assistant message. */
	promptInSession(
		sessionId: string,
		message: string,
		options: Omit<RpcPromptOptions, "sessionId"> = {},
	): Promise<AssistantMessage> {
		return this.prompt(message, { ...options, sessionId });
	}

	async cancel(requestId: string): Promise<boolean> {
		const result = await this.send("cancel", {
			requestId,
			...(this.sessionId ? { sessionId: this.sessionId, runId: requestId } : {}),
		});
		if (result.method !== "cancel") throw new Error("RPC cancel returned an incompatible result.");
		return result.cancelled as boolean;
	}

	async cancelInSession(sessionId: string, runId: string): Promise<boolean> {
		const result = await this.send("cancel", { sessionId, runId, requestId: runId });
		if (result.method !== "cancel") throw new Error("RPC cancel returned an incompatible result.");
		return result.cancelled as boolean;
	}

	/**
	 * Sends an explicitly named, schema-validated RPC request. Consumers should negotiate capabilities
	 * before using extended methods so old process servers remain usable.
	 */
	call(method: RpcMethod, params: Record<string, unknown> = {}, id?: string): Promise<RpcSuccessResult> {
		return this.send(method, params, id);
	}

	async getCapabilities(events: readonly string[] = []): Promise<RpcSuccessResult> {
		const result = await this.send("get_capabilities", { events: [...events] });
		return result;
	}

	async negotiate(events: readonly import("./protocol.ts").RpcExtendedEventName[] = []): Promise<RpcCapabilities> {
		const result = await this.getCapabilities(events);
		return {
			methods: result.methods as readonly RpcMethod[],
			events: result.events as readonly import("./protocol.ts").RpcExtendedEventName[],
			eventBufferSize: result.eventBufferSize as number,
		};
	}

	async resumeEvents(lastSequence?: number): Promise<{ readonly snapshotRequired: boolean }> {
		const result = await this.send("resume_events", lastSequence === undefined ? {} : { lastSequence });
		return { snapshotRequired: result.snapshotRequired as boolean };
	}

	async getOperation(requestId: string): Promise<OperationState> {
		const result = await this.send("get_operation", { requestId });
		return result.operation as OperationState;
	}

	async listSessions(): Promise<readonly RpcSessionInfo[]> {
		const result = await this.send("list_sessions", {});
		return result.sessions as readonly RpcSessionInfo[];
	}

	async newSession(): Promise<RpcSessionInfo> {
		const result = await this.send("new_session", {});
		return result.session as RpcSessionInfo;
	}

	async openSession(sessionId: string): Promise<RpcSessionInfo> {
		const result = await this.send("open_session", { sessionId });
		return result.session as RpcSessionInfo;
	}

	async getProductState(): Promise<RpcProductState> {
		const result = await this.send("get_product_state", {});
		return result.state as RpcProductState;
	}

	async getProjectTrust(): Promise<boolean> {
		const result = await this.send("get_project_trust", {});
		return result.trusted as boolean;
	}

	async getTranscript(
		params: { readonly pageToken?: string; readonly pageSize?: number; readonly maxBytes?: number } = {},
	): Promise<RpcSuccessResult> {
		return this.send("get_transcript", params);
	}

	async getTree(): Promise<RpcSuccessResult> {
		return this.send("get_tree", {});
	}

	async navigateTree(entryId: string): Promise<RpcSuccessResult> {
		return this.send("navigate_tree", { entryId });
	}

	async getModels(): Promise<readonly Model[]> {
		const result = await this.send("get_models", {});
		return result.models as readonly Model[];
	}

	async setModel(modelId: string): Promise<Model> {
		const result = await this.send("set_model", { modelId });
		return result.model as Model;
	}

	async getRuntime(): Promise<RpcRuntimeSnapshot> {
		const result = await this.send("get_runtime", {});
		return {
			providerId: result.providerId as string,
			modelId: result.modelId as string,
			...(result.thinkingLevel === undefined ? {} : { thinkingLevel: result.thinkingLevel as ThinkingLevel }),
		};
	}

	async setRuntime(providerId: string, modelId: string): Promise<Model> {
		const result = await this.send("set_runtime", { providerId, modelId });
		return result.model as Model;
	}

	async setThinkingLevel(level?: ThinkingLevel): Promise<ThinkingLevel | undefined> {
		const result = await this.send("set_thinking_level", level === undefined ? {} : { level });
		return result.level as ThinkingLevel | undefined;
	}

	async compact(): Promise<void> {
		await this.send("compact", {});
	}

	async setCompactionEnabled(enabled: boolean): Promise<boolean> {
		const result = await this.send("set_compaction_enabled", { enabled });
		return result.enabled as boolean;
	}

	async getUsage(): Promise<RpcSuccessResult> {
		return this.send("get_usage", {});
	}

	async listSkills(): Promise<RpcSuccessResult> {
		return this.send("list_skills", {});
	}

	async getResources(): Promise<RpcSuccessResult> {
		return this.send("get_resources", {});
	}

	async steer(message: string, options: RpcPromptOptions = {}): Promise<void> {
		const result = await this.send("steer", {
			message,
			...(options.attachmentIds === undefined ? {} : { attachmentIds: [...options.attachmentIds] }),
		});
		if (result.method !== "steer") throw new Error("RPC steer returned an incompatible result.");
	}

	async retry(targetRequestId: string): Promise<AssistantMessage> {
		const result = await this.send("retry", { targetRequestId });
		if (result.method !== "retry") throw new Error("RPC retry returned an incompatible result.");
		return result.message as AssistantMessage;
	}

	async listProviders(): Promise<readonly RpcProviderSummary[]> {
		const result = await this.send("list_providers", {});
		return result.providers as readonly RpcProviderSummary[];
	}

	async getSettings(): Promise<RpcSettingsSnapshot> {
		const result = await this.send("get_settings", {});
		return result.settings as RpcSettingsSnapshot;
	}

	async setDefaultProvider(providerId: string): Promise<void> {
		await this.send("set_default_provider", { providerId });
	}

	async setDefaultModel(modelId: string): Promise<void> {
		await this.send("set_default_model", { modelId });
	}

	async setLocale(locale: "en" | "zh-CN"): Promise<void> {
		await this.send("set_locale", { locale });
	}

	async setPermissionMode(permissionMode: "ask" | "allow" | "deny"): Promise<void> {
		await this.send("set_permission_mode", { permissionMode });
	}

	async configureCustomProvider(input: {
		readonly api: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
		readonly baseUrl: string;
		readonly apiKey: string;
		readonly modelId: string;
	}): Promise<RpcProviderSummary> {
		const result = await this.send("configure_custom_provider", input);
		return result.provider as RpcProviderSummary;
	}

	async login(
		providerId: string,
		apiKey: string,
		options: { readonly modelId?: string; readonly api?: string } = {},
	): Promise<RpcProviderSummary> {
		const result = await this.send("login", { providerId, apiKey, ...options });
		return result.provider as RpcProviderSummary;
	}

	async logout(providerId: string): Promise<void> {
		await this.send("logout", { providerId });
	}

	async setProjectTrust(trusted: boolean): Promise<boolean> {
		const result = await this.send("set_project_trust", { trusted });
		return result.trusted as boolean;
	}

	async listContextFiles(): Promise<readonly RpcContextFileInfo[]> {
		const result = await this.send("list_context_files", {});
		return result.files as readonly RpcContextFileInfo[];
	}

	async listMcpServers(): Promise<readonly RpcMcpServerInfo[]> {
		const result = await this.send("list_mcp_servers", {});
		return result.servers as readonly RpcMcpServerInfo[];
	}

	async configureMcpServer(
		serverId: string,
		scope: "user" | "project" | "local",
		config: Record<string, unknown>,
	): Promise<RpcMcpServerInfo> {
		const result = await this.send("configure_mcp_server", { serverId, scope, config });
		return result.server as RpcMcpServerInfo;
	}

	async removeMcpServer(serverId: string, scope: "user" | "project" | "local" = "project"): Promise<void> {
		await this.send("remove_mcp_server", { serverId, scope });
	}

	async reconnectMcpServer(serverId: string): Promise<RpcMcpServerInfo> {
		const result = await this.send("reconnect_mcp_server", { serverId });
		return result.server as RpcMcpServerInfo;
	}

	async createAttachment(
		name: string,
		contentType: RpcAttachmentInfo["contentType"],
		data: string,
	): Promise<RpcAttachmentInfo> {
		const result = await this.send("create_attachment", { name, contentType, data });
		return result.attachment as RpcAttachmentInfo;
	}

	async respondInteraction(
		requestId: string,
		result: Omit<UserInteractionResult, "requestId" | "toolCallId">,
	): Promise<void> {
		await this.send("respond_interaction", { requestId, ...result });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.transport.close?.();
		this.rejectPending(new Error("RPC client is closed."));
	}

	private send(
		method: "prompt",
		params: { readonly message: string; readonly attachmentIds?: readonly string[] },
		id?: string,
	): Promise<RpcSuccessResult>;
	private send(method: "cancel", params: { readonly requestId: string }, id?: string): Promise<RpcSuccessResult>;
	private send(method: "get_state", params: Record<string, never>, id?: string): Promise<RpcSuccessResult>;
	private send(method: RpcMethod, params: Record<string, unknown>, id?: string): Promise<RpcSuccessResult>;
	private send(method: RpcMethod, params: Record<string, unknown>, id = randomUUID()): Promise<RpcSuccessResult> {
		if (this.closed) return Promise.reject(new Error("RPC client is closed."));
		const request = { version: RPC_PROTOCOL_VERSION, kind: "request", id, method, params } as RpcRequest;
		return new Promise<RpcSuccessResult>((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
			this.transport.writable.write(serializeJsonLine(request), (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	private readonly handleData = (chunk: string | Buffer): void => {
		try {
			this.decoder.push(chunk);
		} catch (cause) {
			this.fail(cause instanceof Error ? cause : new Error(String(cause)));
		}
	};

	private readonly handleEnd = (): void => {
		try {
			this.decoder.end();
		} catch (cause) {
			this.fail(cause instanceof Error ? cause : new Error(String(cause)));
			return;
		}
		this.fail(new Error("RPC output ended before the client was closed."));
	};

	private readonly handleError = (error: Error): void => this.fail(error);

	private acceptLine(line: string): void {
		const message = parseRpcServerMessage(line);
		if (message.kind === "event") {
			for (const listener of this.listeners) listener(structuredClone(message));
			return;
		}
		if (!message.ok && message.id === undefined) {
			this.fail(new Error(`${message.error.code}: ${message.error.message}`));
			return;
		}
		if (message.id === undefined) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (!message.ok) {
			pending.reject(new RpcRemoteError(message.error.code, message.error.message));
			return;
		}
		if (message.result.method !== pending.method) {
			pending.reject(new Error(`RPC response method mismatch: expected ${pending.method}.`));
			return;
		}
		pending.resolve(message.result);
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private detach(): void {
		this.transport.readable.off("data", this.handleData);
		this.transport.readable.off("end", this.handleEnd);
		this.transport.readable.off("error", this.handleError);
		this.transport.writable.off("error", this.handleError);
		this.removeExitListener?.();
	}
}
