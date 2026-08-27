import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent, Message } from "@di-code/ai";
import type { SessionTreeNode } from "../core/session/types.ts";
import type { AgentSessionEvent, AgentSessionListener } from "../core/session.ts";
import type { ProductHost } from "../runtime/product-host.ts";
import type { SessionHost, SessionHostEvent } from "../runtime/session-host.ts";
import {
	type OperationState,
	type OperationStatus,
	RPC_PROTOCOL_VERSION,
	type RpcAttachmentInfo,
	type RpcErrorCode,
	type RpcEventRecord,
	type RpcMethod,
	type RpcProductState,
	RpcProtocolError,
	type RpcRequest,
	type RpcResponse,
	type RpcServerMessage,
	type RpcSessionState,
	type RpcSuccessResult,
} from "./protocol.ts";

/** Minimum legacy session shape retained for direct RpcServer embedding. */
export interface RpcSession {
	readonly sessionId: string;
	readonly modelId: string;
	readonly isStreaming: boolean;
	readonly transcript: readonly Message[];
	prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage>;
	subscribeSession(listener: AgentSessionListener): () => void;
}

export interface RpcMethodCatalog {
	readonly has: (name: string) => boolean;
}
export interface RpcDispatcherOptions {
	readonly session: RpcSession | SessionHost;
	readonly methods?: RpcMethodCatalog;
	readonly eventBufferSize?: number;
	/** Immutable composition snapshot; changing trust requires a new product host. */
	readonly productState?: RpcProductState;
	readonly productHost?: ProductHost;
	readonly onError?: (error: Error) => void;
	readonly attachmentTtlMs?: number;
	readonly attachmentMaxCount?: number;
	readonly attachmentMaxBytes?: number;
	readonly attachmentStore?: RpcAttachmentStore;
	/** Completed operations remain queryable for this bounded retention window. */
	readonly operationTtlMs?: number;
	/** Active operations are never evicted; this only limits retained terminal records. */
	readonly operationMaxCount?: number;
}

/**
 * Actor-scoped attachment storage. The dispatcher owns validation and opaque IDs; implementations own bytes and
 * must remove consumed, expired, and disposed attachments without exposing their backing paths.
 */
export interface RpcAttachmentStore {
	create(input: {
		readonly id: string;
		readonly name: string;
		readonly contentType: RpcAttachmentInfo["contentType"];
		readonly data: string;
		readonly bytes: number;
	}): Promise<RpcAttachmentInfo>;
	take(ids: readonly string[]): Promise<readonly ImageContent[]>;
	discard(ids: readonly string[]): Promise<void>;
	dispose(): Promise<void>;
}

interface StoredOperation {
	readonly requestId: string;
	readonly kind: RpcMethod;
	readonly controller: AbortController;
	readonly sessionId?: string;
	status: OperationStatus;
	promise?: Promise<RpcResponse>;
	message?: AssistantMessage;
	error?: { readonly code: RpcErrorCode; readonly message: string };
	completedAt?: number;
}

function transcriptEntryIds(tree: readonly SessionTreeNode[], leafId: string | undefined): readonly string[] {
	if (!leafId) return [];
	const visit = (
		nodes: readonly SessionTreeNode[],
		parents: readonly SessionTreeNode[],
	): readonly SessionTreeNode[] | undefined => {
		for (const node of nodes) {
			const branch = [...parents, node];
			if (node.entry.id === leafId) return branch;
			const found = visit(node.children, branch);
			if (found) return found;
		}
		return undefined;
	};
	return (visit(tree, []) ?? []).filter((node) => node.entry.type === "message").map((node) => node.entry.id);
}

class MemoryAttachmentStore implements RpcAttachmentStore {
	private readonly attachments = new Map<
		string,
		{ readonly info: RpcAttachmentInfo; readonly image: ImageContent; readonly createdAt: number }
	>();
	private readonly ttlMs: number;
	private readonly maxCount: number;
	private readonly maxBytes: number;

	constructor(options: { readonly ttlMs: number; readonly maxCount: number; readonly maxBytes: number }) {
		this.ttlMs = options.ttlMs;
		this.maxCount = options.maxCount;
		this.maxBytes = options.maxBytes;
	}

	async create(input: {
		readonly id: string;
		readonly name: string;
		readonly contentType: RpcAttachmentInfo["contentType"];
		readonly data: string;
		readonly bytes: number;
	}): Promise<RpcAttachmentInfo> {
		this.prune();
		const currentBytes = [...this.attachments.values()].reduce((total, item) => total + item.info.bytes, 0);
		if (this.attachments.size >= this.maxCount || currentBytes + input.bytes > this.maxBytes)
			throw new RpcProtocolError("BUSY", "Attachment storage is full; consume or retry later.");
		const info: RpcAttachmentInfo = {
			id: input.id,
			name: input.name,
			contentType: input.contentType,
			bytes: input.bytes,
		};
		this.attachments.set(input.id, {
			info,
			image: { type: "image", data: input.data, mimeType: input.contentType },
			createdAt: Date.now(),
		});
		return info;
	}

	async take(ids: readonly string[]): Promise<readonly ImageContent[]> {
		this.prune();
		const result: ImageContent[] = [];
		for (const id of ids) {
			const attachment = this.attachments.get(id);
			if (!attachment) throw new RpcProtocolError("NOT_FOUND", "RPC attachment was not found.");
			this.attachments.delete(id);
			result.push(structuredClone(attachment.image));
		}
		return result;
	}

	async discard(ids: readonly string[]): Promise<void> {
		for (const id of ids) this.attachments.delete(id);
	}

	async dispose(): Promise<void> {
		this.attachments.clear();
	}

	private prune(): void {
		const cutoff = Date.now() - this.ttlMs;
		for (const [id, attachment] of this.attachments) if (attachment.createdAt <= cutoff) this.attachments.delete(id);
	}
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
function sessionHost(value: RpcSession | SessionHost): value is SessionHost {
	return "state" in value && typeof value.state === "function";
}
function errorCode(cause: unknown): RpcErrorCode {
	if (cause instanceof RpcProtocolError) return cause.code;
	if (cause instanceof Error && "code" in cause) {
		const code = (cause as { code?: string }).code;
		if (
			code === "BUSY" ||
			code === "NOT_FOUND" ||
			code === "CANCELLED" ||
			code === "DISPOSED" ||
			code === "INVALID_INPUT" ||
			code === "SESSION_IN_USE" ||
			code === "INVALID_WORKSPACE"
		)
			return code === "INVALID_INPUT" ? "INVALID_PARAMS" : (code as RpcErrorCode);
	}
	return "INTERNAL_ERROR";
}

/**
 * Transport-free protocol dispatcher. It owns request idempotency, operation state, event ordering,
 * and the bounded replay buffer; callers decide whether events go to JSONL, SSE, or another adapter.
 */
export class RpcDispatcher {
	private readonly session: RpcSession | SessionHost;
	private readonly methods?: RpcMethodCatalog;
	private readonly onError: (error: Error) => void;
	private readonly approvals = new Map<string, { readonly resolve: (approved: boolean) => void }>();
	private readonly maxEvents: number;
	private productState: RpcProductState;
	private readonly productHost?: ProductHost;
	private readonly attachmentTtlMs: number;
	private readonly attachmentMaxCount: number;
	private readonly attachmentMaxBytes: number;
	private readonly operationTtlMs: number;
	private readonly operationMaxCount: number;
	private readonly listeners = new Set<(message: RpcServerMessage) => void>();
	private readonly operations = new Map<string, StoredOperation>();
	private readonly events: RpcEventRecord[] = [];
	private readonly attachments: RpcAttachmentStore;
	private readonly negotiatedEvents = new Set<string>();
	private readonly unsubscribe: () => void;
	private readonly unsubscribeProduct?: () => void;
	private disposed = false;
	private sequence = 0;

	constructor(options: RpcDispatcherOptions) {
		this.session = options.session;
		this.methods = options.methods;
		this.onError = options.onError ?? (() => undefined);
		this.maxEvents = options.eventBufferSize ?? 256;
		this.productState = options.productState ?? { projectTrusted: false };
		this.productHost = options.productHost;
		this.attachmentTtlMs = options.attachmentTtlMs ?? 10 * 60 * 1000;
		this.attachmentMaxCount = options.attachmentMaxCount ?? 32;
		this.attachmentMaxBytes = options.attachmentMaxBytes ?? 64 * 1024 * 1024;
		this.operationTtlMs = options.operationTtlMs ?? 10 * 60 * 1000;
		this.operationMaxCount = options.operationMaxCount ?? 256;
		this.attachments =
			options.attachmentStore ??
			new MemoryAttachmentStore({
				ttlMs: this.attachmentTtlMs,
				maxCount: this.attachmentMaxCount,
				maxBytes: this.attachmentMaxBytes,
			});
		this.unsubscribe = sessionHost(options.session)
			? options.session.subscribe((event) => this.onSessionEvent(event))
			: options.session.subscribeSession((event) => this.onSessionEvent(event));
		if (this.productHost) {
			this.unsubscribeProduct = this.productHost.subscribe((event) => {
				if (!this.negotiatedEvents.has("product_audit")) return;
				this.emit({
					version: RPC_PROTOCOL_VERSION,
					kind: "event",
					requestId: "product",
					sessionId: this.activeSessionId(),
					sequence: ++this.sequence,
					event,
				});
			});
		}
	}

	subscribe(listener: (message: RpcServerMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispatch(request: RpcRequest): Promise<RpcResponse> {
		this.pruneOperations();
		if (this.disposed) return this.failure(request.id, "DISPOSED", "RPC dispatcher has been disposed.");
		if (this.methods && !this.methods.has(request.method))
			return this.failure(request.id, "METHOD_NOT_FOUND", "RPC method is not registered for this server.");
		const existing = this.operations.get(request.id);
		if (existing?.promise) return await existing.promise;
		if (
			request.method === "prompt" &&
			[...this.operations.values()].some((operation) => operation.kind === "prompt" && operation.status === "running")
		)
			return this.failure(request.id, "BUSY", "The RPC session is already processing a prompt.");
		if (this.isOperation(request.method)) {
			const operation: StoredOperation = {
				requestId: request.id,
				kind: request.method,
				controller: new AbortController(),
				sessionId: this.activeSessionId(),
				status: "queued",
			};
			this.operations.set(request.id, operation);
			operation.promise = this.runOperation(operation, request);
			return await operation.promise;
		}
		return await this.execute(request);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.unsubscribeProduct?.();
		for (const operation of this.operations.values())
			if (operation.status === "queued" || operation.status === "running") operation.controller.abort();
		await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise));
		await this.attachments.dispose();
		this.listeners.clear();
	}

	private async execute(request: RpcRequest): Promise<RpcResponse> {
		try {
			switch (request.method) {
				case "get_state":
					return this.success(request.id, { method: "get_state", state: this.state() });
				case "get_capabilities":
					return this.capabilities(request);
				case "resume_events":
					return this.resumeEvents(request);
				case "cancel":
					return this.cancel(request);
				case "get_operation":
					return this.getOperation(request);
				case "list_sessions":
					return this.listSessions(request);
				case "new_session":
					return this.newSession(request);
				case "open_session":
					return this.openSession(request);
				case "inspect_session":
					return this.inspectSession(request);
				case "rename_session":
					return this.renameSession(request);
				case "delete_session":
					return this.deleteSession(request);
				case "branch_session":
					return this.branchSession(request);
				case "get_transcript":
					return this.transcript(request);
				case "get_tree":
					return this.success(request.id, { method: "get_tree", tree: this.host().tree() });
				case "get_models":
					return this.success(request.id, { method: "get_models", models: this.host().ui().availableModels });
				case "get_runtime": {
					const ui = this.host().ui();
					return this.success(request.id, {
						method: "get_runtime",
						providerId: ui.providerId,
						modelId: ui.modelId,
						thinkingLevel: ui.thinkingLevel,
					});
				}
				case "set_compaction_enabled":
					return this.success(request.id, {
						method: "set_compaction_enabled",
						enabled: this.host().setCompactionEnabled(request.params.enabled as boolean),
					});
				case "get_usage":
					return this.success(request.id, { method: "get_usage", usage: this.host().usage() });
				case "list_skills":
					return this.success(request.id, {
						method: "list_skills",
						skills: this.host()
							.ui()
							.availableSkills.map(({ name, description, scope }) => ({ name, description, scope })),
					});
				case "get_resources":
					return this.success(request.id, {
						method: "get_resources",
						models: this.host().ui().availableModels,
						skills: this.host()
							.ui()
							.availableSkills.map(({ name, description, scope }) => ({ name, description, scope })),
					});
				case "get_product_state":
					return this.success(request.id, {
						method: "get_product_state",
						state: this.productHost ? this.productHost.state() : this.productState,
					});
				case "get_project_trust":
					return this.success(request.id, {
						method: "get_project_trust",
						trusted: this.productHost?.getProjectTrust() ?? this.productState.projectTrusted,
					});
				case "create_attachment":
					return await this.createAttachment(request);
				case "list_providers":
					return this.success(request.id, {
						method: "list_providers",
						providers: this.productHost?.listProviders() ?? [],
					});
				case "get_settings":
					return this.success(request.id, { method: "get_settings", settings: this.requireProduct().getSettings() });
				case "list_plugins":
					return this.success(request.id, {
						method: "list_plugins",
						plugins: await this.requireProduct().listPlugins(),
					});
				case "list_web_contributions":
					return this.success(request.id, {
						method: "list_web_contributions",
						manifest: await this.requireProduct().getWebContributions(),
					});
				case "list_context_files":
				case "list_mcp_servers":
				case "login":
				case "logout":
				case "set_default_provider":
				case "set_default_model":
				case "set_locale":
				case "set_permission_mode":
				case "configure_custom_provider":
				case "set_project_trust":
				case "configure_mcp_server":
				case "remove_mcp_server":
				case "reconnect_mcp_server":
				case "set_plugin_enabled":
					return this.failure(
						request.id,
						"METHOD_NOT_FOUND",
						"Product configuration requests require operation dispatch.",
					);
				case "approve_tool":
					{
						const approvalId = request.params.approvalId as string;
						const pending = this.approvals.get(approvalId);
						if (pending) {
							this.approvals.delete(approvalId);
							pending.resolve(request.params.approved === true);
						}
					}
					return this.success(request.id, {
						method: "approve_tool",
						approvalId: request.params.approvalId,
						approved: request.params.approved,
					});
				default:
					return this.failure(request.id, "METHOD_NOT_FOUND", "RPC method is unavailable for this Host.");
			}
		} catch (cause) {
			return this.failure(request.id, errorCode(cause), "RPC request failed.");
		}
	}

	/** Waits for the browser to approve a specific tool invocation. */
	async requestToolApproval(toolName: string, parameters: unknown, signal?: AbortSignal): Promise<boolean> {
		if (!this.negotiatedEvents.has("tool_approval")) return true;
		const approvalId = randomUUID();
		const requestId =
			[...this.operations.values()].find((operation) => operation.status === "running")?.requestId ?? approvalId;
		return await new Promise<boolean>((resolve, reject) => {
			const abort = () => {
				this.approvals.delete(approvalId);
				reject(new Error("Tool approval cancelled."));
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			this.approvals.set(approvalId, {
				resolve: (approved) => {
					signal?.removeEventListener("abort", abort);
					resolve(approved);
				},
			});
			this.emit({
				version: RPC_PROTOCOL_VERSION,
				kind: "event",
				requestId,
				sessionId: this.activeSessionId(),
				sequence: ++this.sequence,
				event: {
					type: "tool_approval",
					approvalId,
					toolName,
					arguments: typeof parameters === "object" && parameters !== null ? parameters : {},
				},
			});
		});
	}

	private async runOperation(operation: StoredOperation, request: RpcRequest): Promise<RpcResponse> {
		operation.status = "running";
		this.emitOperation(operation);
		try {
			let result: RpcSuccessResult;
			switch (request.method) {
				case "prompt": {
					const message = await this.prompt(request.params.message as string, request.params, operation);
					operation.message = message;
					result = { method: "prompt", message };
					break;
				}
				case "steer": {
					const images = await this.takeAttachments(request.params);
					if (images.length === 0) {
						await this.host().steer(
							{ text: request.params.message as string, requestId: request.id },
							operation.controller.signal,
						);
					} else {
						await this.host().steerWithImages(request.params.message as string, images, operation.controller.signal);
					}
					result = { method: "steer" };
					break;
				}
				case "retry": {
					const message = await this.host().retry(
						{ targetRequestId: request.params.targetRequestId as string },
						operation.controller.signal,
					);
					operation.message = message;
					result = { method: "retry", message };
					break;
				}
				case "compact":
					await this.host().compact(operation.controller.signal);
					result = { method: "compact" };
					break;
				case "navigate_tree":
					result = {
						method: "navigate_tree",
						navigation: await this.host().navigateTree(request.params.entryId as string),
					};
					break;
				case "set_model":
					result = { method: "set_model", model: this.host().setModel(request.params.modelId as string) };
					break;
				case "set_runtime": {
					this.assertProductIdle();
					const providerId = request.params.providerId as string;
					const modelId = request.params.modelId as string;
					await this.requireProduct().setRuntimePreference(providerId, modelId);
					const runtime = this.host().ui();
					const model = runtime.availableModels.find((candidate) => candidate.id === runtime.modelId);
					if (!model) throw new Error("The selected runtime was not applied to the active Session.");
					result = {
						method: "set_runtime",
						model,
					};
					break;
				}
				case "set_thinking_level": {
					this.assertProductIdle();
					const ui = this.host().ui();
					const model = ui.availableModels.find((candidate) => candidate.id === ui.modelId);
					const efforts = model?.reasoningEfforts ?? [];
					const requested = request.params.level as import("@di-code/ai").ThinkingLevel | undefined;
					const next =
						requested ??
						(efforts.length === 0
							? undefined
							: efforts[
									((ui.thinkingLevel === undefined ? -1 : efforts.indexOf(ui.thinkingLevel)) + 1) % efforts.length
								]);
					if (next !== undefined)
						await this.requireProduct().setThinkingLevelPreference(ui.providerId, ui.modelId, next);
					result = {
						method: "set_thinking_level",
						level: next === undefined ? this.host().cycleThinkingLevel() : this.host().setThinkingLevel(next),
					};
					break;
				}
				case "list_context_files":
					result = {
						method: "list_context_files",
						files: await this.requireProduct().listContextFiles(operation.controller.signal),
					};
					break;
				case "list_mcp_servers":
					result = {
						method: "list_mcp_servers",
						servers: await this.requireProduct().listMcpServers(operation.controller.signal),
					};
					break;
				case "login":
					this.assertProductIdle();
					result = {
						method: "login",
						provider: await this.requireProduct().login(
							{
								providerId: request.params.providerId as string,
								apiKey: request.params.apiKey as string,
								modelId: request.params.modelId as string | undefined,
								api: request.params.api as string | undefined,
							},
							operation.controller.signal,
						),
					};
					break;
				case "logout":
					this.assertProductIdle();
					await this.requireProduct().logout(request.params.providerId as string, operation.controller.signal);
					result = { method: "logout" };
					break;
				case "set_default_provider":
					this.assertProductIdle();
					await this.requireProduct().setDefaultProvider(request.params.providerId as string);
					result = { method: "set_default_provider" };
					break;
				case "set_default_model":
					this.assertProductIdle();
					await this.requireProduct().setDefaultModel(request.params.modelId as string);
					result = { method: "set_default_model" };
					break;
				case "set_locale":
					this.assertProductIdle();
					await this.requireProduct().setLocale(request.params.locale as "en" | "zh-CN");
					result = { method: "set_locale" };
					break;
				case "set_permission_mode":
					this.assertProductIdle();
					await this.requireProduct().setPermissionMode(request.params.permissionMode as "ask" | "allow" | "deny");
					result = { method: "set_permission_mode" };
					break;
				case "configure_custom_provider":
					this.assertProductIdle();
					result = {
						method: "configure_custom_provider",
						provider: await this.requireProduct().configureCustomProvider(
							{
								api: request.params.api as Exclude<import("@di-code/ai").ModelApi, "faux">,
								baseUrl: request.params.baseUrl as string,
								apiKey: request.params.apiKey as string,
								modelId: request.params.modelId as string,
							},
							operation.controller.signal,
						),
					};
					break;
				case "set_project_trust": {
					this.assertProductIdle();
					const trusted = await this.requireProduct().setProjectTrust(
						request.params.trusted as boolean,
						operation.controller.signal,
					);
					this.productState = { projectTrusted: trusted };
					result = { method: "set_project_trust", trusted };
					break;
				}
				case "configure_mcp_server":
					this.assertProductIdle();
					result = {
						method: "configure_mcp_server",
						server: await this.requireProduct().configureMcpServer(
							{
								serverId: request.params.serverId as string,
								scope: request.params.scope as "user" | "project" | "local",
								config: request.params.config as Record<string, unknown>,
							},
							operation.controller.signal,
						),
					};
					break;
				case "remove_mcp_server":
					this.assertProductIdle();
					await this.requireProduct().removeMcpServer(
						request.params.serverId as string,
						(request.params.scope as "user" | "project" | "local" | undefined) ?? "project",
						operation.controller.signal,
					);
					result = { method: "remove_mcp_server" };
					break;
				case "reconnect_mcp_server":
					this.assertProductIdle();
					result = {
						method: "reconnect_mcp_server",
						server: await this.requireProduct().reconnectMcpServer(
							request.params.serverId as string,
							operation.controller.signal,
						),
					};
					break;
				case "set_plugin_enabled":
					this.assertProductIdle();
					result = {
						method: "set_plugin_enabled",
						plugin: await this.requireProduct().setPluginEnabled(
							request.params.pluginId as string,
							request.params.enabled as boolean,
							operation.controller.signal,
						),
					};
					break;
				default:
					return this.failure(request.id, "METHOD_NOT_FOUND", "RPC method is unavailable for this Host.");
			}
			operation.status = "completed";
			operation.completedAt = Date.now();
			this.emitOperation(operation);
			this.pruneOperations();
			return this.success(request.id, result);
		} catch (cause) {
			const code = operation.controller.signal.aborted ? "CANCELLED" : errorCode(cause);
			operation.status = code === "CANCELLED" ? "cancelled" : "failed";
			operation.completedAt = Date.now();
			operation.error = {
				code,
				message: code === "CANCELLED" ? "The RPC operation was cancelled." : "The RPC operation failed.",
			};
			this.emitOperation(operation);
			this.pruneOperations();
			if (code === "INTERNAL_ERROR") this.onError(errorFrom(cause));
			return this.failure(request.id, operation.error.code, operation.error.message);
		} finally {
			await this.discardAttachments(request.params);
		}
	}
	private transcript(request: RpcRequest): RpcResponse {
		const all = this.host().transcript();
		const entryIds = transcriptEntryIds(this.host().tree(), this.host().ui().sessionLeafId);
		if (entryIds.length !== all.length)
			throw new RpcProtocolError("INTERNAL_ERROR", "Session transcript entries are inconsistent.");
		const start = request.params.pageToken === undefined ? 0 : Number.parseInt(request.params.pageToken as string, 10);
		if (!Number.isSafeInteger(start) || start < 0 || start > all.length)
			return this.failure(request.id, "INVALID_PARAMS", "Invalid transcript page token.");
		const pageSize = (request.params.pageSize as number | undefined) ?? 100;
		const maxBytes = (request.params.maxBytes as number | undefined) ?? 1_000_000;
		const transcript = [] as (typeof all)[number][];
		const pageEntryIds: string[] = [];
		let bytes = 2;
		for (let index = start; index < all.length && transcript.length < pageSize; index++) {
			const value = all[index];
			if (value === undefined) break;
			const size = Buffer.byteLength(JSON.stringify(value), "utf8");
			if (size > maxBytes && transcript.length === 0)
				return this.failure(request.id, "INVALID_PARAMS", "Transcript entry exceeds maxBytes.");
			if (bytes + size > maxBytes) break;
			transcript.push(value);
			pageEntryIds.push(entryIds[index] ?? "");
			bytes += size;
		}
		const next = start + transcript.length < all.length ? String(start + transcript.length) : undefined;
		return this.success(request.id, {
			method: "get_transcript",
			transcript,
			entryIds: pageEntryIds,
			...(next ? { nextPageToken: next } : {}),
		});
	}
	private requireProduct(): ProductHost {
		if (!this.productHost) throw new RpcProtocolError("METHOD_NOT_FOUND", "ProductHost is unavailable.");
		return this.productHost;
	}
	private assertProductIdle(): void {
		if (sessionHost(this.session) && this.session.state().busy)
			throw new RpcProtocolError("BUSY", "Product configuration cannot change while the Session is busy.");
	}
	private async discardAttachments(params: Record<string, unknown>): Promise<void> {
		const ids = params.attachmentIds;
		if (!Array.isArray(ids)) return;
		await this.attachments.discard(ids.filter((id): id is string => typeof id === "string"));
	}

	private async prompt(
		message: string,
		params: Record<string, unknown>,
		operation: StoredOperation,
	): Promise<AssistantMessage> {
		const images = await this.takeAttachments(params);
		if (sessionHost(this.session)) {
			if (images.length > 0) return await this.session.promptWithImages(message, images, operation.controller.signal);
			return await this.session.prompt({ text: message, requestId: operation.requestId }, operation.controller.signal);
		}
		if (images.length > 0) throw new RpcProtocolError("METHOD_NOT_FOUND", "RPC attachments require a SessionHost.");
		return await this.session.prompt(message, operation.controller.signal);
	}
	private async createAttachment(request: RpcRequest): Promise<RpcResponse> {
		const data = request.params.data as string;
		if (Buffer.from(data, "base64").toString("base64") !== data)
			return this.failure(request.id, "INVALID_PARAMS", "Attachment data must be canonical base64.");
		const bytes = Buffer.byteLength(data, "base64");
		if (bytes === 0 || bytes > 5 * 1024 * 1024)
			return this.failure(request.id, "INVALID_PARAMS", "Attachment data exceeds the permitted size.");
		const contentType = request.params.contentType as RpcAttachmentInfo["contentType"];
		const info = await this.attachments.create({
			id: randomUUID(),
			name: request.params.name as string,
			contentType,
			data,
			bytes,
		});
		return this.success(request.id, { method: "create_attachment", attachment: info });
	}
	private async takeAttachments(params: Record<string, unknown>): Promise<readonly ImageContent[]> {
		const ids = params.attachmentIds as readonly string[] | undefined;
		if (!ids || ids.length === 0) return [];
		return await this.attachments.take(ids);
	}
	private host(): SessionHost {
		if (!sessionHost(this.session))
			throw new RpcProtocolError("METHOD_NOT_FOUND", "RPC method requires a SessionHost.");
		return this.session;
	}
	private state(): RpcSessionState {
		if (sessionHost(this.session)) {
			const state = this.session.state();
			const ui = state.activeSession ? this.session.ui() : undefined;
			return {
				sessionId: state.activeSession?.id ?? "uninitialized",
				modelId: ui?.modelId ?? "uninitialized",
				isStreaming: state.busy,
				messageCount: state.activeSession ? this.session.transcript().length : 0,
				sequence: this.sequence,
			};
		}
		return {
			sessionId: this.session.sessionId,
			modelId: this.session.modelId,
			isStreaming: this.session.isStreaming,
			messageCount: this.session.transcript.length,
			sequence: this.sequence,
		};
	}
	private activeSessionId(): string | undefined {
		return sessionHost(this.session) ? this.session.state().activeSession?.id : this.session.sessionId;
	}
	private isOperation(method: RpcMethod): boolean {
		return [
			"prompt",
			"steer",
			"retry",
			"compact",
			"navigate_tree",
			"set_model",
			"set_runtime",
			"set_thinking_level",
			"list_context_files",
			"list_mcp_servers",
			"login",
			"logout",
			"set_default_provider",
			"set_default_model",
			"set_locale",
			"set_permission_mode",
			"configure_custom_provider",
			"set_project_trust",
			"configure_mcp_server",
			"remove_mcp_server",
			"reconnect_mcp_server",
			"set_plugin_enabled",
		].includes(method);
	}
	private success(id: string, result: RpcSuccessResult): RpcResponse {
		return { version: RPC_PROTOCOL_VERSION, kind: "response", id, ok: true, result };
	}
	private failure(id: string, code: RpcErrorCode, message: string): RpcResponse {
		return { version: RPC_PROTOCOL_VERSION, kind: "response", id, ok: false, error: { code, message } };
	}
	private capabilities(request: RpcRequest): RpcResponse {
		const events = request.params.events;
		if (Array.isArray(events))
			for (const event of events)
				if (
					typeof event === "string" &&
					[
						"sequence",
						"operation_update",
						"snapshot_required",
						"session_changed",
						"tool_approval",
						"product_audit",
					].includes(event)
				)
					this.negotiatedEvents.add(event);
		return this.success(request.id, {
			method: "get_capabilities",
			methods: RPC_METHODS_FOR_CAPABILITIES,
			events: [...this.negotiatedEvents],
			eventBufferSize: this.maxEvents,
		});
	}
	private resumeEvents(request: RpcRequest): RpcResponse {
		const last = request.params.lastSequence as number | undefined;
		if (!this.negotiatedEvents.has("sequence"))
			return this.failure(request.id, "INVALID_PARAMS", "Extended events require capability negotiation.");
		if (last !== undefined && this.events.length > 0 && last < (this.events[0]?.sequence ?? 0) - 1) {
			this.emit({
				version: RPC_PROTOCOL_VERSION,
				kind: "event",
				requestId: request.id,
				sessionId: this.activeSessionId(),
				sequence: ++this.sequence,
				event: { type: "snapshot_required" },
			});
			return this.success(request.id, { method: "resume_events", snapshotRequired: true });
		}
		for (const event of this.events) if ((event.sequence ?? 0) > (last ?? 0)) this.emit(event);
		return this.success(request.id, { method: "resume_events", snapshotRequired: false });
	}
	private cancel(request: RpcRequest): RpcResponse {
		const target = request.params.requestId as string;
		const operation = this.operations.get(target);
		const cancelled = operation !== undefined && (operation.status === "queued" || operation.status === "running");
		if (cancelled) {
			operation.controller.abort();
			if (sessionHost(this.session)) this.session.cancel(target);
		}
		return this.success(request.id, { method: "cancel", cancelled });
	}
	private getOperation(request: RpcRequest): RpcResponse {
		this.pruneOperations();
		const operation = this.operations.get(request.params.requestId as string);
		return operation
			? this.success(request.id, { method: "get_operation", operation: this.operationState(operation) })
			: this.failure(request.id, "NOT_FOUND", "RPC operation was not found.");
	}
	private async listSessions(request: RpcRequest): Promise<RpcResponse> {
		return this.success(request.id, {
			method: "list_sessions",
			sessions: await this.host()
				.listSessions()
				.then((items) =>
					items.map(({ id, label, modifiedAt, stats }) => ({ id, label, modifiedAt, ...(stats ? { stats } : {}) })),
				),
		});
	}
	private async newSession(request: RpcRequest): Promise<RpcResponse> {
		const session = await this.host().createSession();
		return this.success(request.id, {
			method: "new_session",
			session: {
				id: session.id,
				label: session.label,
				modifiedAt: session.modifiedAt,
				...(session.stats ? { stats: session.stats } : {}),
			},
		});
	}
	private async openSession(request: RpcRequest): Promise<RpcResponse> {
		const session = await this.host().openSession(request.params.sessionId as string);
		return this.success(request.id, {
			method: "open_session",
			session: {
				id: session.id,
				label: session.label,
				modifiedAt: session.modifiedAt,
				...(session.stats ? { stats: session.stats } : {}),
			},
		});
	}
	private async inspectSession(request: RpcRequest): Promise<RpcResponse> {
		const snapshot = await this.host().inspectSession(request.params.sessionId as string);
		return this.success(request.id, {
			method: "inspect_session",
			snapshot: {
				session: {
					id: snapshot.session.id,
					label: snapshot.session.label,
					modifiedAt: snapshot.session.modifiedAt,
					...(snapshot.session.stats ? { stats: snapshot.session.stats } : {}),
				},
				transcript: snapshot.transcript,
				tree: snapshot.tree,
				stats: snapshot.stats,
				readOnly: true,
			},
		});
	}
	private async renameSession(request: RpcRequest): Promise<RpcResponse> {
		const session = await this.host().renameSession(request.params.sessionId as string, request.params.label as string);
		return this.success(request.id, { method: "rename_session", session });
	}
	private async deleteSession(request: RpcRequest): Promise<RpcResponse> {
		await this.host().deleteSession(request.params.sessionId as string, request.params.confirmation as string);
		return this.success(request.id, { method: "delete_session" });
	}
	private async branchSession(request: RpcRequest): Promise<RpcResponse> {
		const session = await this.host().branchSession(
			request.params.sessionId as string | undefined,
			request.params.entryId as string | undefined,
		);
		return this.success(request.id, { method: "branch_session", session });
	}
	private operationState(operation: StoredOperation): OperationState {
		return {
			requestId: operation.requestId,
			kind: operation.kind,
			status: operation.status,
			...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
			...(operation.message ? { message: operation.message } : {}),
			...(operation.error ? { error: operation.error } : {}),
		};
	}
	private pruneOperations(): void {
		const cutoff = Date.now() - this.operationTtlMs;
		for (const [id, operation] of this.operations)
			if (operation.completedAt !== undefined && operation.completedAt <= cutoff) this.operations.delete(id);
		const retained = [...this.operations.values()]
			.filter((operation) => operation.completedAt !== undefined)
			.sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
		while (retained.length > this.operationMaxCount) {
			const operation = retained.shift();
			if (operation) this.operations.delete(operation.requestId);
		}
	}
	private emitOperation(operation: StoredOperation): void {
		if (!this.negotiatedEvents.has("operation_update")) return;
		this.emit({
			version: RPC_PROTOCOL_VERSION,
			kind: "event",
			requestId: operation.requestId,
			sessionId: operation.sessionId,
			sequence: ++this.sequence,
			event: { type: "operation_update", operation: this.operationState(operation) },
		});
	}
	private onSessionEvent(event: SessionHostEvent | AgentSessionEvent): void {
		const operation = [...this.operations.values()].find((item) => item.status === "running");
		const extended = event.type === "session_changed";
		if (extended && !this.negotiatedEvents.has("session_changed")) return;
		const record: RpcEventRecord = {
			version: RPC_PROTOCOL_VERSION,
			kind: "event",
			requestId: operation?.requestId ?? "session",
			event,
			...(this.negotiatedEvents.has("sequence")
				? { sessionId: this.activeSessionId(), sequence: ++this.sequence }
				: {}),
		};
		if (this.negotiatedEvents.has("sequence")) {
			this.events.push(record);
			if (this.events.length > this.maxEvents) this.events.shift();
		}
		this.emit(record);
	}
	private emit(message: RpcServerMessage): void {
		for (const listener of this.listeners) {
			try {
				listener(structuredClone(message));
			} catch (cause) {
				this.onError(errorFrom(cause));
			}
		}
	}
}

const RPC_METHODS_FOR_CAPABILITIES = [
	"get_state",
	"get_capabilities",
	"resume_events",
	"list_sessions",
	"new_session",
	"open_session",
	"get_transcript",
	"get_tree",
	"navigate_tree",
	"inspect_session",
	"rename_session",
	"delete_session",
	"branch_session",
	"prompt",
	"steer",
	"retry",
	"cancel",
	"get_operation",
	"get_models",
	"set_model",
	"get_runtime",
	"set_runtime",
	"set_thinking_level",
	"compact",
	"set_compaction_enabled",
	"get_usage",
	"list_skills",
	"get_resources",
	"get_product_state",
	"list_providers",
	"get_settings",
	"set_default_provider",
	"set_default_model",
	"set_locale",
	"set_permission_mode",
	"login",
	"logout",
	"get_project_trust",
	"set_project_trust",
	"list_context_files",
	"list_mcp_servers",
	"configure_mcp_server",
	"remove_mcp_server",
	"reconnect_mcp_server",
	"create_attachment",
	"approve_tool",
] as const;
