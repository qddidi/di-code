import type { AssistantMessage } from "@di-code/ai";
import { validateWebManifest } from "@di-code/plugin-runtime";
import type { AgentSessionEvent } from "../core/session.ts";

export const RPC_PROTOCOL_VERSION = 1 as const;
export const RPC_MAX_ID_LENGTH = 128;
export const RPC_MAX_PROMPT_LENGTH = 1_000_000;
export const RPC_MAX_ATTACHMENTS_PER_REQUEST = 4;
export const RPC_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Allows one JSONL user entry containing a maximum-sized base64 image to be read in a single transcript page. */
export const RPC_MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const RPC_MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(RPC_MAX_ATTACHMENT_BYTES / 3) * 4;

/** v1 grows only by methods and optional fields. Clients must negotiate extended events first. */
export const RPC_METHODS = [
	"prompt",
	"cancel",
	"get_state",
	"get_capabilities",
	"resume_events",
	"list_sessions",
	"new_session",
	"open_session",
	"inspect_session",
	"rename_session",
	"delete_session",
	"branch_session",
	"get_transcript",
	"get_tree",
	"navigate_tree",
	"steer",
	"retry",
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
	"configure_custom_provider",
	"login",
	"logout",
	"get_project_trust",
	"set_project_trust",
	"list_context_files",
	"list_mcp_servers",
	"configure_mcp_server",
	"remove_mcp_server",
	"reconnect_mcp_server",
	"list_plugins",
	"list_web_contributions",
	"list_commands",
	"run_command",
	"set_plugin_enabled",
	"create_attachment",
	"approve_tool",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export interface RpcRequest {
	readonly version: typeof RPC_PROTOCOL_VERSION;
	readonly kind: "request";
	readonly id: string;
	readonly method: RpcMethod;
	readonly params: Record<string, unknown>;
}

export interface RpcSessionState {
	readonly sessionId: string;
	readonly modelId: string;
	readonly isStreaming: boolean;
	readonly messageCount: number;
	readonly sequence?: number;
}

/** Metadata for an opaque attachment handle kept only by its live RPC actor. */
export interface RpcAttachmentInfo {
	readonly id: string;
	readonly name: string;
	readonly contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	readonly bytes: number;
}

export interface RpcCapabilities {
	readonly methods: readonly RpcMethod[];
	readonly events: readonly RpcExtendedEventName[];
	readonly eventBufferSize: number;
}

export type RpcExtendedEventName =
	| "sequence"
	| "operation_update"
	| "snapshot_required"
	| "session_changed"
	| "tool_approval"
	| "product_audit";

export interface RpcProductState {
	readonly projectTrusted: boolean;
}

export interface RpcProviderSummary {
	readonly id: string;
	readonly name: string;
	readonly models: readonly {
		readonly id: string;
		readonly name: string;
		readonly input: readonly string[];
		/** Omitted when the model does not expose selectable reasoning levels. */
		readonly reasoningEfforts?: readonly ("low" | "medium" | "high" | "max")[];
	}[];
	readonly configured: boolean;
}

export interface RpcSettingsSnapshot {
	readonly providers: readonly (RpcProviderSummary & {
		readonly api: string;
		readonly baseUrl?: string;
		readonly apiKeySource: "environment" | "settings" | "missing";
	})[];
	readonly defaults: { readonly providerId?: string; readonly modelId?: string };
	readonly runtime: { readonly providerId: string; readonly modelId: string; readonly thinkingLevel?: string };
	readonly locale?: "en" | "zh-CN";
	readonly permissionMode: "ask" | "allow" | "deny";
	readonly sources: Readonly<Record<string, "environment" | "settings" | "default" | "runtime">>;
}

export interface RpcContextFileInfo {
	readonly path: string;
	readonly scope: string;
	readonly bytes: number;
}

/** A user-invocable command projected from the active composition or Skill catalog. */
export interface RpcCommandInfo {
	readonly name: string;
	readonly description: string;
	readonly kind: "command" | "skill";
}

/** A WebUI operation requested by a registered command. */
export interface RpcCommandAction {
	readonly command: string;
	readonly args: string;
}

export interface RpcMcpServerInfo {
	readonly id: string;
	readonly scope?: string;
	readonly state: "configured" | "connected" | "failed" | "disconnected";
	readonly tools: number;
	readonly resources: number;
	readonly prompts: number;
	readonly diagnostic?: string;
}

export type OperationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "crashed";
export interface OperationState {
	readonly requestId: string;
	readonly kind: RpcMethod;
	readonly status: OperationStatus;
	readonly sessionId?: string;
	readonly message?: AssistantMessage;
	readonly error?: { readonly code: RpcErrorCode; readonly message: string };
}

/** Method-specific result fields are validated at the wire boundary. */
export type RpcSuccessResult = { readonly method: RpcMethod; readonly [key: string]: unknown };

export type RpcErrorCode =
	| "PARSE_ERROR"
	| "INVALID_REQUEST"
	| "UNSUPPORTED_VERSION"
	| "METHOD_NOT_FOUND"
	| "INVALID_PARAMS"
	| "BUSY"
	| "NOT_FOUND"
	| "CANCELLED"
	| "DISPOSED"
	| "SESSION_IN_USE"
	| "INVALID_WORKSPACE"
	| "UNAUTHORIZED"
	| "INTERNAL_ERROR"
	| "PROCESS_EXIT";

const RPC_ERROR_CODES: ReadonlySet<RpcErrorCode> = new Set([
	"PARSE_ERROR",
	"INVALID_REQUEST",
	"UNSUPPORTED_VERSION",
	"METHOD_NOT_FOUND",
	"INVALID_PARAMS",
	"BUSY",
	"NOT_FOUND",
	"CANCELLED",
	"DISPOSED",
	"SESSION_IN_USE",
	"INVALID_WORKSPACE",
	"UNAUTHORIZED",
	"INTERNAL_ERROR",
	"PROCESS_EXIT",
]);
const LEGACY_EVENT_TYPES: ReadonlySet<AgentSessionEvent["type"]> = new Set([
	"agent_start",
	"turn_start",
	"message_start",
	"message_update",
	"message_end",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"agent_end",
	"compaction_start",
	"compaction_end",
	"queue_update",
	"tree_navigated",
	"usage_update",
]);
const EXTENDED_EVENT_TYPES = new Set([
	"snapshot_required",
	"operation_update",
	"session_changed",
	"tool_approval",
	"product_audit",
]);
const EXTENDED_EVENT_NAMES: ReadonlySet<RpcExtendedEventName> = new Set([
	"sequence",
	"operation_update",
	"snapshot_required",
	"session_changed",
	"tool_approval",
	"product_audit",
]);
const ASSISTANT_STOP_REASONS = new Set(["stop", "length", "tool_use", "error", "aborted"]);

export interface RpcSuccessResponse {
	readonly version: typeof RPC_PROTOCOL_VERSION;
	readonly kind: "response";
	readonly id: string;
	readonly ok: true;
	readonly result: RpcSuccessResult;
}
export interface RpcErrorResponse {
	readonly version: typeof RPC_PROTOCOL_VERSION;
	readonly kind: "response";
	readonly id?: string;
	readonly ok: false;
	readonly error: { readonly code: RpcErrorCode; readonly message: string };
}
export interface RpcEventRecord {
	readonly version: typeof RPC_PROTOCOL_VERSION;
	readonly kind: "event";
	readonly requestId: string;
	readonly event:
		| AgentSessionEvent
		| {
				readonly type: "product_audit";
				readonly action:
					| "login"
					| "logout"
					| "set_project_trust"
					| "configure_mcp_server"
					| "remove_mcp_server"
					| "reconnect_mcp_server";
				readonly target?: string;
				readonly projectTrusted?: boolean;
		  }
		| {
				readonly type: "snapshot_required" | "operation_update" | "session_changed" | "tool_approval";
				readonly [key: string]: unknown;
		  };
	readonly sessionId?: string;
	readonly sequence?: number;
}
export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type RpcServerMessage = RpcResponse | RpcEventRecord;

export class RpcProtocolError extends Error {
	readonly code: RpcErrorCode;
	readonly requestId?: string;

	constructor(code: RpcErrorCode, message: string, requestId?: string) {
		super(message);
		this.name = "RpcProtocolError";
		this.code = code;
		this.requestId = requestId;
	}
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function requiredId(value: unknown, field: string, requestId?: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > RPC_MAX_ID_LENGTH)
		throw new RpcProtocolError(
			"INVALID_REQUEST",
			`${field} must be a non-empty string of at most ${RPC_MAX_ID_LENGTH} characters.`,
			requestId,
		);
	return value;
}
function parseJsonObject(line: string): Record<string, unknown> {
	try {
		const result = objectRecord(JSON.parse(line));
		if (!result) throw new RpcProtocolError("INVALID_REQUEST", "RPC input must be a JSON object.");
		return result;
	} catch (cause) {
		if (cause instanceof RpcProtocolError) throw cause;
		throw new RpcProtocolError("PARSE_ERROR", "RPC input must be valid JSON.");
	}
}
function assertVersion(record: Record<string, unknown>, requestId?: string): void {
	if (record.version !== RPC_PROTOCOL_VERSION)
		throw new RpcProtocolError(
			"UNSUPPORTED_VERSION",
			`Unsupported RPC protocol version; expected ${RPC_PROTOCOL_VERSION}.`,
			requestId,
		);
}
function stringParam(params: Record<string, unknown>, name: string, id: string, optional = false): void {
	const value = params[name];
	if (optional && value === undefined) return;
	if (typeof value !== "string" || value.length === 0 || value.length > RPC_MAX_PROMPT_LENGTH)
		throw new RpcProtocolError("INVALID_PARAMS", `${name} must be a non-empty string.`, id);
}
function booleanParam(params: Record<string, unknown>, name: string, id: string): void {
	if (typeof params[name] !== "boolean") throw new RpcProtocolError("INVALID_PARAMS", `${name} must be a boolean.`, id);
}
function attachmentIdsParam(params: Record<string, unknown>, id: string): void {
	if (params.attachmentIds === undefined) return;
	if (
		!Array.isArray(params.attachmentIds) ||
		params.attachmentIds.length > RPC_MAX_ATTACHMENTS_PER_REQUEST ||
		!params.attachmentIds.every(
			(value) => typeof value === "string" && value.length > 0 && value.length <= RPC_MAX_ID_LENGTH,
		)
	)
		throw new RpcProtocolError(
			"INVALID_PARAMS",
			`attachmentIds must contain at most ${RPC_MAX_ATTACHMENTS_PER_REQUEST} attachment IDs.`,
			id,
		);
}
function attachmentDataParam(params: Record<string, unknown>, id: string): void {
	const data = params.data;
	if (typeof data !== "string" || data.length === 0 || data.length > RPC_MAX_ATTACHMENT_BASE64_LENGTH)
		throw new RpcProtocolError("INVALID_PARAMS", "Attachment data exceeds the permitted size.", id);
}

/** Parses every public v1 method before any dispatcher or transport observes it. */
export function parseRpcRequest(line: string): RpcRequest {
	const record = parseJsonObject(line);
	const candidateId = typeof record.id === "string" ? record.id : undefined;
	assertVersion(record, candidateId);
	if (record.kind !== "request")
		throw new RpcProtocolError("INVALID_REQUEST", 'RPC request kind must be "request".', candidateId);
	const id = requiredId(record.id, "id", candidateId);
	const params = objectRecord(record.params);
	if (!params) throw new RpcProtocolError("INVALID_PARAMS", "RPC params must be an object.", id);
	if (typeof record.method !== "string" || !RPC_METHODS.includes(record.method as RpcMethod))
		throw new RpcProtocolError("METHOD_NOT_FOUND", "Unknown RPC method.", id);
	const method = record.method as RpcMethod;
	switch (method) {
		case "prompt":
		case "steer":
			stringParam(params, "message", id);
			attachmentIdsParam(params, id);
			break;
		case "cancel":
		case "get_operation":
		case "open_session":
		case "inspect_session":
		case "rename_session":
		case "delete_session":
		case "navigate_tree":
		case "set_model":
		case "logout":
		case "reconnect_mcp_server":
			stringParam(
				params,
				method === "cancel" || method === "get_operation"
					? "requestId"
					: method === "open_session"
						? "sessionId"
						: method === "inspect_session" || method === "rename_session" || method === "delete_session"
							? "sessionId"
							: method === "navigate_tree"
								? "entryId"
								: method === "set_model"
									? "modelId"
									: method === "logout"
										? "providerId"
										: "serverId",
				id,
			);
			if (method === "rename_session") stringParam(params, "label", id);
			if (method === "delete_session") stringParam(params, "confirmation", id);
			break;
		case "branch_session":
			if (params.sessionId !== undefined) stringParam(params, "sessionId", id, true);
			if (params.entryId !== undefined) stringParam(params, "entryId", id, true);
			break;
		case "set_runtime":
			stringParam(params, "providerId", id);
			stringParam(params, "modelId", id);
			break;
		case "run_command":
			stringParam(params, "name", id);
			if (!/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/.test(params.name as string))
				throw new RpcProtocolError("INVALID_PARAMS", "run_command.name is invalid.", id);
			if (params.args !== undefined && (typeof params.args !== "string" || params.args.length > RPC_MAX_PROMPT_LENGTH))
				throw new RpcProtocolError("INVALID_PARAMS", "args must be a string of at most 1,000,000 characters.", id);
			break;
		case "set_default_provider":
		case "set_default_model":
		case "set_locale":
		case "set_permission_mode":
			stringParam(
				params,
				method === "set_default_provider"
					? "providerId"
					: method === "set_default_model"
						? "modelId"
						: method === "set_locale"
							? "locale"
							: "permissionMode",
				id,
			);
			if (method === "set_locale" && params.locale !== "en" && params.locale !== "zh-CN")
				throw new RpcProtocolError("INVALID_PARAMS", "locale must be en or zh-CN.", id);
			if (
				method === "set_permission_mode" &&
				params.permissionMode !== "ask" &&
				params.permissionMode !== "allow" &&
				params.permissionMode !== "deny"
			)
				throw new RpcProtocolError("INVALID_PARAMS", "permissionMode must be ask, allow, or deny.", id);
			break;
		case "configure_custom_provider":
			for (const name of ["api", "baseUrl", "apiKey", "modelId"]) stringParam(params, name, id);
			if (!["openai-responses", "openai-chat-completions", "anthropic-messages"].includes(params.api as string))
				throw new RpcProtocolError("INVALID_PARAMS", "Unsupported custom Provider API.", id);
			break;
		case "set_thinking_level":
			if (
				params.level !== undefined &&
				params.level !== "low" &&
				params.level !== "medium" &&
				params.level !== "high" &&
				params.level !== "max"
			)
				throw new RpcProtocolError("INVALID_PARAMS", "set_thinking_level.level must be a valid thinking level.", id);
			break;
		case "retry":
			stringParam(params, "targetRequestId", id);
			break;
		case "login":
			stringParam(params, "providerId", id);
			stringParam(params, "apiKey", id);
			if (params.modelId !== undefined) stringParam(params, "modelId", id, true);
			if (params.api !== undefined) stringParam(params, "api", id, true);
			break;
		case "configure_mcp_server":
			stringParam(params, "serverId", id);
			stringParam(params, "scope", id);
			if (!objectRecord(params.config)) throw new RpcProtocolError("INVALID_PARAMS", "config must be an object.", id);
			break;
		case "remove_mcp_server":
			stringParam(params, "serverId", id);
			if (params.scope !== undefined) stringParam(params, "scope", id, true);
			break;
		case "set_plugin_enabled":
			stringParam(params, "pluginId", id);
			booleanParam(params, "enabled", id);
			break;
		case "set_compaction_enabled":
		case "set_project_trust":
			booleanParam(params, method === "set_compaction_enabled" ? "enabled" : "trusted", id);
			break;
		case "get_capabilities":
			if (
				params.events !== undefined &&
				(!Array.isArray(params.events) || !params.events.every((item) => typeof item === "string"))
			)
				throw new RpcProtocolError("INVALID_PARAMS", "get_capabilities.events must be a string array.", id);
			break;
		case "resume_events":
			if (
				params.lastSequence !== undefined &&
				(!Number.isSafeInteger(params.lastSequence) || (params.lastSequence as number) < 0)
			)
				throw new RpcProtocolError("INVALID_PARAMS", "resume_events.lastSequence must be a non-negative integer.", id);
			break;
		case "create_attachment":
			stringParam(params, "name", id);
			stringParam(params, "contentType", id);
			attachmentDataParam(params, id);
			if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(params.contentType as string))
				throw new RpcProtocolError("INVALID_PARAMS", "Attachment contentType is unsupported.", id);
			break;
		case "get_transcript":
			if (params.pageToken !== undefined) stringParam(params, "pageToken", id, true);
			if (
				params.pageSize !== undefined &&
				(!Number.isSafeInteger(params.pageSize) || (params.pageSize as number) < 1 || (params.pageSize as number) > 200)
			)
				throw new RpcProtocolError("INVALID_PARAMS", "pageSize must be an integer between 1 and 200.", id);
			if (
				params.maxBytes !== undefined &&
				(!Number.isSafeInteger(params.maxBytes) ||
					(params.maxBytes as number) < 1024 ||
					(params.maxBytes as number) > RPC_MAX_TRANSCRIPT_BYTES)
			)
				throw new RpcProtocolError(
					"INVALID_PARAMS",
					`maxBytes must be between 1024 and ${RPC_MAX_TRANSCRIPT_BYTES}.`,
					id,
				);
			break;
		case "approve_tool":
			stringParam(params, "approvalId", id);
			booleanParam(params, "approved", id);
			break;
	}
	return { version: RPC_PROTOCOL_VERSION, kind: "request", id, method, params };
}

export function parseRpcServerMessage(line: string): RpcServerMessage {
	const record = parseJsonObject(line);
	assertVersion(record);
	if (record.kind === "event") {
		requiredId(record.requestId, "requestId");
		const event = objectRecord(record.event);
		const type = event?.type;
		if (
			typeof type !== "string" ||
			(!LEGACY_EVENT_TYPES.has(type as AgentSessionEvent["type"]) && !EXTENDED_EVENT_TYPES.has(type))
		)
			throw new RpcProtocolError("INVALID_REQUEST", "RPC event must contain a typed event object.");
		if (!event) throw new RpcProtocolError("INVALID_REQUEST", "RPC event must contain a typed event object.");
		if (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0))
			throw new RpcProtocolError("INVALID_REQUEST", "RPC event sequence is invalid.");
		assertEvent(event, type);
		return record as unknown as RpcEventRecord;
	}
	if (record.kind !== "response")
		throw new RpcProtocolError("INVALID_REQUEST", 'RPC server message kind must be "response" or "event".');
	if (record.ok === false) {
		const error = objectRecord(record.error);
		if (
			!error ||
			typeof error.code !== "string" ||
			!RPC_ERROR_CODES.has(error.code as RpcErrorCode) ||
			typeof error.message !== "string"
		)
			throw new RpcProtocolError("INVALID_REQUEST", "RPC error response has an invalid error object.");
		if (record.id !== undefined) requiredId(record.id, "id");
		return record as unknown as RpcErrorResponse;
	}
	if (record.ok !== true) throw new RpcProtocolError("INVALID_REQUEST", "RPC response ok must be a boolean.");
	requiredId(record.id, "id");
	const result = objectRecord(record.result);
	if (!result || typeof result.method !== "string" || !RPC_METHODS.includes(result.method as RpcMethod))
		throw new RpcProtocolError("INVALID_REQUEST", "RPC success response has an unknown method.");
	assertSuccessResult(result);
	return record as unknown as RpcSuccessResponse;
}
function assertSuccessResult(result: Record<string, unknown>): void {
	switch (result.method as RpcMethod) {
		case "prompt":
		case "retry":
			assertAssistantMessage(result.message);
			return;
		case "cancel":
			if (typeof result.cancelled !== "boolean")
				throw new RpcProtocolError("INVALID_REQUEST", "RPC cancel result is invalid.");
			return;
		case "get_state":
			assertState(result.state);
			return;
		case "get_capabilities":
			assertCapabilities(result);
			return;
		case "resume_events":
			if (typeof result.snapshotRequired !== "boolean")
				throw new RpcProtocolError("INVALID_REQUEST", "RPC resume_events result is invalid.");
			return;
		case "get_operation":
			assertOperationState(result.operation);
			return;
		case "create_attachment":
			assertAttachmentInfo(result.attachment);
			return;
		case "get_product_state":
			assertProductState(result.state);
			return;
		case "get_project_trust":
			if (typeof result.trusted !== "boolean")
				throw new RpcProtocolError("INVALID_REQUEST", "RPC get_project_trust result is invalid.");
			return;
		case "list_sessions":
			if (!Array.isArray(result.sessions))
				throw new RpcProtocolError("INVALID_REQUEST", "RPC list_sessions result is invalid.");
			for (const session of result.sessions) assertSessionInfo(session);
			return;
		case "new_session":
		case "open_session":
		case "rename_session":
		case "branch_session":
			assertSessionInfo(result.session);
			return;
		case "inspect_session":
			if (!objectRecord(result.snapshot))
				throw new RpcProtocolError("INVALID_REQUEST", "RPC Session snapshot is invalid.");
			return;
		case "list_providers":
			if (!Array.isArray(result.providers))
				throw new RpcProtocolError("INVALID_REQUEST", "RPC providers result is invalid.");
			return;
		case "list_context_files":
			if (!Array.isArray(result.files))
				throw new RpcProtocolError("INVALID_REQUEST", "RPC context files result is invalid.");
			return;
		case "list_mcp_servers":
			if (!Array.isArray(result.servers)) throw new RpcProtocolError("INVALID_REQUEST", "RPC MCP result is invalid.");
			return;
		case "list_web_contributions":
			{
				const manifest = objectRecord(result.manifest);
				if (!manifest || !validateWebManifest(manifest))
					throw new RpcProtocolError("INVALID_REQUEST", "RPC Web contribution manifest is invalid.");
			}
			return;
		case "list_commands":
			if (!Array.isArray(result.commands))
				throw new RpcProtocolError("INVALID_REQUEST", "RPC commands result is invalid.");
			for (const command of result.commands) assertCommandInfo(command);
			return;
		case "run_command":
			if (typeof result.command !== "string" || !result.command)
				throw new RpcProtocolError("INVALID_REQUEST", "RPC command result is invalid.");
			if (result.action !== undefined) assertCommandAction(result.action);
			return;
		case "configure_mcp_server":
		case "reconnect_mcp_server":
			if (!objectRecord(result.server)) throw new RpcProtocolError("INVALID_REQUEST", "RPC MCP result is invalid.");
			return;
		case "login":
			if (!objectRecord(result.provider)) throw new RpcProtocolError("INVALID_REQUEST", "RPC login result is invalid.");
			return;
		case "set_project_trust":
			if (typeof result.trusted !== "boolean")
				throw new RpcProtocolError("INVALID_REQUEST", "RPC trust result is invalid.");
			return;
		case "logout":
		case "remove_mcp_server":
			return;
		case "get_settings":
			if (!objectRecord(result.settings))
				throw new RpcProtocolError("INVALID_REQUEST", "RPC settings result is invalid.");
			return;
		case "set_default_provider":
		case "set_default_model":
		case "set_locale":
		case "set_permission_mode":
		case "configure_custom_provider":
			return;
	}
}
function assertCapabilities(result: Record<string, unknown>): void {
	if (
		!Array.isArray(result.methods) ||
		!result.methods.every((method) => typeof method === "string" && RPC_METHODS.includes(method as RpcMethod)) ||
		!Array.isArray(result.events) ||
		!result.events.every(
			(event) => typeof event === "string" && EXTENDED_EVENT_NAMES.has(event as RpcExtendedEventName),
		) ||
		!Number.isSafeInteger(result.eventBufferSize) ||
		(result.eventBufferSize as number) < 0
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC get_capabilities result is invalid.");
}
function assertSessionInfo(value: unknown): void {
	const session = objectRecord(value);
	if (!session || typeof session.id !== "string" || !session.id || typeof session.label !== "string")
		throw new RpcProtocolError("INVALID_REQUEST", "RPC Session result is invalid.");
	if (session.modifiedAt !== undefined && !Number.isFinite(session.modifiedAt))
		throw new RpcProtocolError("INVALID_REQUEST", "RPC Session modifiedAt is invalid.");
}
function assertCommandInfo(value: unknown): void {
	const command = objectRecord(value);
	if (
		!command ||
		typeof command.name !== "string" ||
		!command.name ||
		typeof command.description !== "string" ||
		(command.kind !== "command" && command.kind !== "skill")
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC command info is invalid.");
}
function assertCommandAction(value: unknown): void {
	const action = objectRecord(value);
	if (!action || typeof action.command !== "string" || !action.command || typeof action.args !== "string")
		throw new RpcProtocolError("INVALID_REQUEST", "RPC command action is invalid.");
}
function assertOperationState(value: unknown): void {
	const operation = objectRecord(value);
	if (
		!operation ||
		typeof operation.requestId !== "string" ||
		!operation.requestId ||
		typeof operation.kind !== "string" ||
		!RPC_METHODS.includes(operation.kind as RpcMethod) ||
		typeof operation.status !== "string" ||
		!["queued", "running", "completed", "failed", "cancelled", "crashed"].includes(operation.status)
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC operation state is invalid.");
	if (operation.sessionId !== undefined && typeof operation.sessionId !== "string")
		throw new RpcProtocolError("INVALID_REQUEST", "RPC operation session ID is invalid.");
	if (operation.message !== undefined) assertAssistantMessage(operation.message);
	if (operation.error !== undefined) assertError(operation.error);
}
function assertAttachmentInfo(value: unknown): void {
	const attachment = objectRecord(value);
	if (
		!attachment ||
		typeof attachment.id !== "string" ||
		!attachment.id ||
		typeof attachment.name !== "string" ||
		!attachment.name ||
		typeof attachment.contentType !== "string" ||
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.contentType) ||
		!Number.isSafeInteger(attachment.bytes) ||
		(attachment.bytes as number) < 0
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC attachment result is invalid.");
}
function assertProductState(value: unknown): void {
	const state = objectRecord(value);
	if (!state || typeof state.projectTrusted !== "boolean")
		throw new RpcProtocolError("INVALID_REQUEST", "RPC product state is invalid.");
}
function assertError(value: unknown): void {
	const error = objectRecord(value);
	if (
		!error ||
		typeof error.code !== "string" ||
		!RPC_ERROR_CODES.has(error.code as RpcErrorCode) ||
		typeof error.message !== "string"
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC error result is invalid.");
}
function assertEvent(event: Record<string, unknown>, type: string): void {
	if (type === "operation_update") {
		assertOperationState(event.operation);
		return;
	}
	if (type === "session_changed") {
		if (event.session !== undefined) assertSessionInfo(event.session);
		return;
	}
	if (type === "snapshot_required") return;
	if (type === "tool_approval") {
		if (typeof event.approvalId !== "string")
			throw new RpcProtocolError("INVALID_REQUEST", "RPC tool_approval event is invalid.");
		return;
	}
	if (type === "product_audit") {
		if (
			typeof event.action !== "string" ||
			![
				"login",
				"logout",
				"set_project_trust",
				"configure_mcp_server",
				"remove_mcp_server",
				"reconnect_mcp_server",
			].includes(event.action) ||
			(event.target !== undefined && typeof event.target !== "string") ||
			(event.projectTrusted !== undefined && typeof event.projectTrusted !== "boolean")
		)
			throw new RpcProtocolError("INVALID_REQUEST", "RPC product_audit event is invalid.");
		return;
	}
	if (type === "tool_execution_start") {
		if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || !objectRecord(event.arguments))
			throw new RpcProtocolError("INVALID_REQUEST", "RPC tool event is invalid.");
		return;
	}
	if (type === "tool_execution_end") {
		if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || !objectRecord(event.result))
			throw new RpcProtocolError("INVALID_REQUEST", "RPC tool event is invalid.");
		return;
	}
	if (type === "message_start" || type === "message_end") {
		if (!objectRecord(event.message)) throw new RpcProtocolError("INVALID_REQUEST", "RPC message event is invalid.");
		return;
	}
	if (type === "message_update") {
		const update = objectRecord(event.event);
		if (!update || typeof update.type !== "string")
			throw new RpcProtocolError("INVALID_REQUEST", "RPC message update event is invalid.");
		return;
	}
	if (type === "turn_end") {
		if (!objectRecord(event.message) || !Array.isArray(event.toolResults))
			throw new RpcProtocolError("INVALID_REQUEST", "RPC turn event is invalid.");
		return;
	}
	if (type === "agent_end") {
		if (!Array.isArray(event.messages)) throw new RpcProtocolError("INVALID_REQUEST", "RPC agent event is invalid.");
		return;
	}
	if (type === "compaction_start") {
		if (event.reason !== "threshold" && event.reason !== "manual")
			throw new RpcProtocolError("INVALID_REQUEST", "RPC compaction event is invalid.");
		return;
	}
	if (type === "compaction_end") {
		if (
			(event.reason !== "threshold" && event.reason !== "manual") ||
			typeof event.success !== "boolean" ||
			(event.errorMessage !== undefined && typeof event.errorMessage !== "string")
		)
			throw new RpcProtocolError("INVALID_REQUEST", "RPC compaction event is invalid.");
		return;
	}
	if (type === "queue_update") {
		if (!Array.isArray(event.steering) || !event.steering.every((item) => typeof item === "string"))
			throw new RpcProtocolError("INVALID_REQUEST", "RPC queue event is invalid.");
		return;
	}
	if (type === "tree_navigated") {
		if (
			typeof event.oldLeafId !== "string" ||
			typeof event.newLeafId !== "string" ||
			typeof event.selectedEntryId !== "string" ||
			typeof event.restoredEditorText !== "boolean"
		)
			throw new RpcProtocolError("INVALID_REQUEST", "RPC tree event is invalid.");
		return;
	}
	if (type === "usage_update" && !objectRecord(event.usage)) {
		throw new RpcProtocolError("INVALID_REQUEST", "RPC usage event is invalid.");
	}
}
function assertState(value: unknown): void {
	const state = objectRecord(value);
	if (
		!state ||
		typeof state.sessionId !== "string" ||
		!state.sessionId ||
		typeof state.modelId !== "string" ||
		!state.modelId ||
		typeof state.isStreaming !== "boolean" ||
		!Number.isInteger(state.messageCount) ||
		(state.messageCount as number) < 0
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC get_state response has an invalid state.");
}
function assertAssistantMessage(value: unknown): void {
	const message = objectRecord(value);
	if (
		!message ||
		message.role !== "assistant" ||
		!Array.isArray(message.content) ||
		typeof message.provider !== "string" ||
		typeof message.model !== "string" ||
		!Number.isFinite(message.timestamp) ||
		typeof message.stopReason !== "string" ||
		!ASSISTANT_STOP_REASONS.has(message.stopReason)
	)
		throw new RpcProtocolError("INVALID_REQUEST", "RPC prompt response has an invalid message.");
}
export function rpcErrorResponse(error: RpcProtocolError): RpcErrorResponse {
	return {
		version: RPC_PROTOCOL_VERSION,
		kind: "response",
		...(error.requestId === undefined ? {} : { id: error.requestId }),
		ok: false,
		error: { code: error.code, message: error.message },
	};
}
