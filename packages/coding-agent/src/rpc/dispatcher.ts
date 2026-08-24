import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent, Message } from "@di-code/ai";
import type { AgentSessionEvent, AgentSessionListener } from "../core/session.ts";
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
	readonly onError?: (error: Error) => void;
	readonly attachmentTtlMs?: number;
	readonly attachmentMaxCount?: number;
	readonly attachmentMaxBytes?: number;
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
}

interface StoredAttachment {
	readonly info: RpcAttachmentInfo;
	readonly image: ImageContent;
	readonly createdAt: number;
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
			code === "INVALID_INPUT"
		)
			return code === "INVALID_INPUT" ? "INVALID_PARAMS" : code;
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
	private readonly maxEvents: number;
	private readonly productState: RpcProductState;
	private readonly attachmentTtlMs: number;
	private readonly attachmentMaxCount: number;
	private readonly attachmentMaxBytes: number;
	private readonly listeners = new Set<(message: RpcServerMessage) => void>();
	private readonly operations = new Map<string, StoredOperation>();
	private readonly events: RpcEventRecord[] = [];
	private readonly attachments = new Map<string, StoredAttachment>();
	private readonly negotiatedEvents = new Set<string>();
	private readonly unsubscribe: () => void;
	private disposed = false;
	private sequence = 0;

	constructor(options: RpcDispatcherOptions) {
		this.session = options.session;
		this.methods = options.methods;
		this.onError = options.onError ?? (() => undefined);
		this.maxEvents = options.eventBufferSize ?? 256;
		this.productState = options.productState ?? { projectTrusted: false };
		this.attachmentTtlMs = options.attachmentTtlMs ?? 10 * 60 * 1000;
		this.attachmentMaxCount = options.attachmentMaxCount ?? 32;
		this.attachmentMaxBytes = options.attachmentMaxBytes ?? 64 * 1024 * 1024;
		this.unsubscribe = sessionHost(options.session)
			? options.session.subscribe((event) => this.onSessionEvent(event))
			: options.session.subscribeSession((event) => this.onSessionEvent(event));
	}

	subscribe(listener: (message: RpcServerMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispatch(request: RpcRequest): Promise<RpcResponse> {
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
		for (const operation of this.operations.values())
			if (operation.status === "queued" || operation.status === "running") operation.controller.abort();
		await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise));
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
				case "get_transcript":
					return this.success(request.id, { method: "get_transcript", transcript: this.host().transcript() });
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
					return this.success(request.id, { method: "get_product_state", state: this.productState });
				case "get_project_trust":
					return this.success(request.id, { method: "get_project_trust", trusted: this.productState.projectTrusted });
				case "create_attachment":
					return this.createAttachment(request);
				case "list_providers":
					return this.success(request.id, { method: "list_providers", providers: [] });
				case "list_context_files":
					return this.success(request.id, { method: "list_context_files", files: [] });
				case "list_mcp_servers":
					return this.success(request.id, { method: "list_mcp_servers", servers: [] });
				default:
					return this.failure(request.id, "METHOD_NOT_FOUND", "RPC method is unavailable for this Host.");
			}
		} catch (cause) {
			return this.failure(request.id, errorCode(cause), "RPC request failed.");
		}
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
					const images = this.takeAttachments(request.params);
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
					const message = await this.host().retry(operation.controller.signal);
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
				case "set_runtime":
					result = {
						method: "set_runtime",
						model: this.host().setRuntime(request.params.providerId as string, request.params.modelId as string),
					};
					break;
				case "set_thinking_level":
					result = { method: "set_thinking_level", level: this.host().setThinkingLevel() };
					break;
				default:
					return this.failure(request.id, "METHOD_NOT_FOUND", "RPC method is unavailable for this Host.");
			}
			operation.status = "completed";
			this.emitOperation(operation);
			return this.success(request.id, result);
		} catch (cause) {
			const code = operation.controller.signal.aborted ? "CANCELLED" : errorCode(cause);
			operation.status = code === "CANCELLED" ? "cancelled" : "failed";
			operation.error = {
				code,
				message: code === "CANCELLED" ? "The RPC operation was cancelled." : "The RPC operation failed.",
			};
			this.emitOperation(operation);
			if (code === "INTERNAL_ERROR") this.onError(errorFrom(cause));
			return this.failure(request.id, operation.error.code, operation.error.message);
		}
	}

	private async prompt(
		message: string,
		params: Record<string, unknown>,
		operation: StoredOperation,
	): Promise<AssistantMessage> {
		const images = this.takeAttachments(params);
		if (sessionHost(this.session)) {
			if (images.length > 0) return await this.session.promptWithImages(message, images, operation.controller.signal);
			return await this.session.prompt({ text: message, requestId: operation.requestId }, operation.controller.signal);
		}
		if (images.length > 0) throw new RpcProtocolError("METHOD_NOT_FOUND", "RPC attachments require a SessionHost.");
		return await this.session.prompt(message, operation.controller.signal);
	}
	private createAttachment(request: RpcRequest): RpcResponse {
		this.pruneAttachments();
		const data = request.params.data as string;
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
			return this.failure(request.id, "INVALID_PARAMS", "Attachment data must be canonical base64.");
		const bytes = Buffer.byteLength(data, "base64");
		if (bytes === 0 || bytes > 5 * 1024 * 1024)
			return this.failure(request.id, "INVALID_PARAMS", "Attachment data exceeds the permitted size.");
		const currentBytes = [...this.attachments.values()].reduce((total, item) => total + item.info.bytes, 0);
		if (this.attachments.size >= this.attachmentMaxCount || currentBytes + bytes > this.attachmentMaxBytes)
			return this.failure(request.id, "BUSY", "Attachment storage is full; consume or retry later.");
		const id = randomUUID();
		const contentType = request.params.contentType as RpcAttachmentInfo["contentType"];
		const info: RpcAttachmentInfo = { id, name: request.params.name as string, contentType, bytes };
		this.attachments.set(id, { info, image: { type: "image", data, mimeType: contentType }, createdAt: Date.now() });
		return this.success(request.id, { method: "create_attachment", attachment: info });
	}
	private pruneAttachments(): void {
		const cutoff = Date.now() - this.attachmentTtlMs;
		for (const [id, attachment] of this.attachments) {
			if (attachment.createdAt <= cutoff) this.attachments.delete(id);
		}
	}
	private takeAttachments(params: Record<string, unknown>): readonly ImageContent[] {
		this.pruneAttachments();
		const ids = params.attachmentIds as readonly string[] | undefined;
		if (!ids || ids.length === 0) return [];
		const result: ImageContent[] = [];
		for (const id of ids) {
			const attachment = this.attachments.get(id);
			if (!attachment) throw new RpcProtocolError("NOT_FOUND", "RPC attachment was not found.");
			this.attachments.delete(id);
			result.push(structuredClone(attachment.image));
		}
		return result;
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
					["sequence", "operation_update", "snapshot_required", "session_changed", "tool_approval"].includes(event)
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
				.then((items) => items.map(({ id, label, modifiedAt }) => ({ id, label, modifiedAt }))),
		});
	}
	private async newSession(request: RpcRequest): Promise<RpcResponse> {
		const session = await this.host().createSession();
		return this.success(request.id, {
			method: "new_session",
			session: { id: session.id, label: session.label, modifiedAt: session.modifiedAt },
		});
	}
	private async openSession(request: RpcRequest): Promise<RpcResponse> {
		const session = await this.host().openSession(request.params.sessionId as string);
		return this.success(request.id, {
			method: "open_session",
			session: { id: session.id, label: session.label, modifiedAt: session.modifiedAt },
		});
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
	"get_capabilities",
	"resume_events",
	"list_sessions",
	"new_session",
	"open_session",
	"get_transcript",
	"get_tree",
	"navigate_tree",
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
] as const;
