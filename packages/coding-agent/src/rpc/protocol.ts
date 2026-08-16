import type { AssistantMessage } from "@di-code/ai";
import type { AgentSessionEvent } from "../core/session.ts";

export const RPC_PROTOCOL_VERSION = 1 as const;
export const RPC_MAX_ID_LENGTH = 128;
export const RPC_MAX_PROMPT_LENGTH = 1_000_000;

export type RpcMethod = "prompt" | "cancel" | "get_state";

export type RpcRequest =
	| {
			readonly version: typeof RPC_PROTOCOL_VERSION;
			readonly kind: "request";
			readonly id: string;
			readonly method: "prompt";
			readonly params: { readonly message: string };
	  }
	| {
			readonly version: typeof RPC_PROTOCOL_VERSION;
			readonly kind: "request";
			readonly id: string;
			readonly method: "cancel";
			readonly params: { readonly requestId: string };
	  }
	| {
			readonly version: typeof RPC_PROTOCOL_VERSION;
			readonly kind: "request";
			readonly id: string;
			readonly method: "get_state";
			readonly params: Record<string, never>;
	  };

export interface RpcSessionState {
	readonly sessionId: string;
	readonly modelId: string;
	readonly isStreaming: boolean;
	readonly messageCount: number;
}

export type RpcSuccessResult =
	| { readonly method: "prompt"; readonly message: AssistantMessage }
	| { readonly method: "cancel"; readonly cancelled: boolean }
	| { readonly method: "get_state"; readonly state: RpcSessionState };

export type RpcErrorCode =
	| "PARSE_ERROR"
	| "INVALID_REQUEST"
	| "UNSUPPORTED_VERSION"
	| "METHOD_NOT_FOUND"
	| "INVALID_PARAMS"
	| "BUSY"
	| "NOT_FOUND"
	| "CANCELLED"
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
	"INTERNAL_ERROR",
	"PROCESS_EXIT",
]);

const RPC_EVENT_TYPES: ReadonlySet<AgentSessionEvent["type"]> = new Set([
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
	"usage_update",
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
	readonly event: AgentSessionEvent;
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
	if (typeof value !== "string" || value.length === 0 || value.length > RPC_MAX_ID_LENGTH) {
		throw new RpcProtocolError(
			"INVALID_REQUEST",
			`${field} must be a non-empty string of at most ${RPC_MAX_ID_LENGTH} characters.`,
			requestId,
		);
	}
	return value;
}

function parseJsonObject(line: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new RpcProtocolError("PARSE_ERROR", "RPC input must be valid JSON.");
	}
	const record = objectRecord(value);
	if (!record) throw new RpcProtocolError("INVALID_REQUEST", "RPC input must be a JSON object.");
	return record;
}

function assertVersion(record: Record<string, unknown>, requestId?: string): void {
	if (record.version !== RPC_PROTOCOL_VERSION) {
		throw new RpcProtocolError(
			"UNSUPPORTED_VERSION",
			`Unsupported RPC protocol version; expected ${RPC_PROTOCOL_VERSION}.`,
			requestId,
		);
	}
}

export function parseRpcRequest(line: string): RpcRequest {
	const record = parseJsonObject(line);
	const candidateId = typeof record.id === "string" ? record.id : undefined;
	assertVersion(record, candidateId);
	if (record.kind !== "request") {
		throw new RpcProtocolError("INVALID_REQUEST", 'RPC request kind must be "request".', candidateId);
	}
	const id = requiredId(record.id, "id", candidateId);
	const params = objectRecord(record.params);
	if (!params) throw new RpcProtocolError("INVALID_PARAMS", "RPC params must be an object.", id);

	switch (record.method) {
		case "prompt": {
			const message = params.message;
			if (typeof message !== "string" || message.trim().length === 0 || message.length > RPC_MAX_PROMPT_LENGTH) {
				throw new RpcProtocolError(
					"INVALID_PARAMS",
					`prompt.message must be non-empty and at most ${RPC_MAX_PROMPT_LENGTH} characters.`,
					id,
				);
			}
			return { version: RPC_PROTOCOL_VERSION, kind: "request", id, method: "prompt", params: { message } };
		}
		case "cancel":
			return {
				version: RPC_PROTOCOL_VERSION,
				kind: "request",
				id,
				method: "cancel",
				params: { requestId: requiredId(params.requestId, "cancel.requestId", id) },
			};
		case "get_state":
			return { version: RPC_PROTOCOL_VERSION, kind: "request", id, method: "get_state", params: {} };
		default:
			throw new RpcProtocolError("METHOD_NOT_FOUND", "Unknown RPC method.", id);
	}
}

export function parseRpcServerMessage(line: string): RpcServerMessage {
	const record = parseJsonObject(line);
	assertVersion(record);
	if (record.kind === "event") {
		requiredId(record.requestId, "requestId");
		const event = objectRecord(record.event);
		if (!event || typeof event.type !== "string" || !RPC_EVENT_TYPES.has(event.type as AgentSessionEvent["type"])) {
			throw new RpcProtocolError("INVALID_REQUEST", "RPC event must contain a typed event object.");
		}
		return record as unknown as RpcEventRecord;
	}
	if (record.kind !== "response") {
		throw new RpcProtocolError("INVALID_REQUEST", 'RPC server message kind must be "response" or "event".');
	}
	if (record.ok === false) {
		const error = objectRecord(record.error);
		if (
			!error ||
			typeof error.code !== "string" ||
			!RPC_ERROR_CODES.has(error.code as RpcErrorCode) ||
			typeof error.message !== "string"
		) {
			throw new RpcProtocolError("INVALID_REQUEST", "RPC error response has an invalid error object.");
		}
		if (record.id !== undefined) requiredId(record.id, "id");
		return record as unknown as RpcErrorResponse;
	}
	if (record.ok !== true) throw new RpcProtocolError("INVALID_REQUEST", "RPC response ok must be a boolean.");
	requiredId(record.id, "id");
	const result = objectRecord(record.result);
	if (!result) {
		throw new RpcProtocolError("INVALID_REQUEST", "RPC success response must contain a result object.");
	}
	assertSuccessResult(result);
	return record as unknown as RpcSuccessResponse;
}

function assertSuccessResult(result: Record<string, unknown>): void {
	switch (result.method) {
		case "prompt": {
			const message = objectRecord(result.message);
			if (
				!message ||
				message.role !== "assistant" ||
				!Array.isArray(message.content) ||
				!message.content.every(isAssistantContent) ||
				typeof message.provider !== "string" ||
				typeof message.model !== "string" ||
				!finiteNumber(message.timestamp) ||
				typeof message.stopReason !== "string" ||
				!ASSISTANT_STOP_REASONS.has(message.stopReason) ||
				!isUsage(message.usage) ||
				(message.stopReason === "error" || message.stopReason === "aborted"
					? typeof message.errorMessage !== "string"
					: message.errorMessage !== undefined)
			) {
				throw new RpcProtocolError("INVALID_REQUEST", "RPC prompt response has an invalid message.");
			}
			return;
		}
		case "cancel":
			if (typeof result.cancelled !== "boolean") {
				throw new RpcProtocolError("INVALID_REQUEST", "RPC cancel response has an invalid result.");
			}
			return;
		case "get_state": {
			const state = objectRecord(result.state);
			if (
				!state ||
				typeof state.sessionId !== "string" ||
				state.sessionId.length === 0 ||
				typeof state.modelId !== "string" ||
				state.modelId.length === 0 ||
				typeof state.isStreaming !== "boolean" ||
				!Number.isInteger(state.messageCount) ||
				(state.messageCount as number) < 0
			) {
				throw new RpcProtocolError("INVALID_REQUEST", "RPC get_state response has an invalid state.");
			}
			return;
		}
		default:
			throw new RpcProtocolError("INVALID_REQUEST", "RPC success response has an unknown method.");
	}
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): value is number {
	return finiteNumber(value) && value >= 0;
}

function isAssistantContent(value: unknown): boolean {
	const content = objectRecord(value);
	if (!content) return false;
	switch (content.type) {
		case "text":
			return typeof content.text === "string";
		case "thinking":
			return typeof content.thinking === "string";
		case "tool_call":
			return (
				typeof content.id === "string" &&
				typeof content.name === "string" &&
				objectRecord(content.arguments) !== undefined
			);
		default:
			return false;
	}
}

function isUsage(value: unknown): boolean {
	const usage = objectRecord(value);
	const cost = objectRecord(usage?.cost);
	return Boolean(
		usage &&
			cost &&
			nonNegativeNumber(usage.input) &&
			nonNegativeNumber(usage.output) &&
			nonNegativeNumber(usage.cacheRead) &&
			nonNegativeNumber(usage.cacheWrite) &&
			nonNegativeNumber(usage.totalTokens) &&
			nonNegativeNumber(cost.input) &&
			nonNegativeNumber(cost.output) &&
			nonNegativeNumber(cost.cacheRead) &&
			nonNegativeNumber(cost.cacheWrite) &&
			nonNegativeNumber(cost.total),
	);
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
