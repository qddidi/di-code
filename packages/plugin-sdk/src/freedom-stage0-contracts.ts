/**
 * Stage 0 contract for the freedom extension API. This file is intentionally
 * declarative: runtime wiring is introduced only by later stages.
 */
export const EXTENSION_API_VERSION = 1 as const;
export const EXTENSION_PROTOCOL_VERSION = 1 as const;
export const EXTENSION_MAX_PAYLOAD_BYTES = 256 * 1024;
export const EXTENSION_DEFAULT_TIMEOUT_MS = 30_000;

export type ExtensionApiVersion = typeof EXTENSION_API_VERSION;
export type ExtensionProtocolVersion = typeof EXTENSION_PROTOCOL_VERSION;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ExtensionId = string & { readonly __extensionId: unique symbol };
export type SessionId = string & { readonly __sessionId: unique symbol };
export type TaskId = string & { readonly __taskId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };
export type Disposer = () => void | Promise<void>;

export type ExtensionErrorCode =
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "DUPLICATE"
	| "PERMISSION_DENIED"
	| "SESSION_UNAVAILABLE"
	| "PROVIDER_UNAVAILABLE"
	| "JOB_UNAVAILABLE"
	| "UI_UNAVAILABLE"
	| "NETWORK_UNAVAILABLE"
	| "SUBPROCESS_UNAVAILABLE"
	| "CANCELLED"
	| "TIMEOUT"
	| "RESOURCE_LIMIT"
	| "CONFLICT"
	| "DISPOSED"
	| "FAILED"
	| "NEEDS_RECONCILIATION";

export interface ExtensionErrorShape {
	readonly version: ExtensionApiVersion;
	readonly code: ExtensionErrorCode;
	readonly message: string;
	readonly requestId?: RequestId;
	readonly retryable: boolean;
	readonly details?: JsonValue;
}

export interface OperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly requestId?: RequestId;
}

export interface ExtensionEventMap {
	readonly [event: string]: JsonValue;
}

export interface ExtensionAPI {
	readonly apiVersion: ExtensionApiVersion;
	readonly ctx: ExtensionContext;
	readonly on: <K extends keyof ExtensionEventMap & string>(
		event: K,
		listener: (payload: ExtensionEventMap[K]) => void | Promise<void>,
	) => Disposer;
	readonly registerCommand: (command: CommandRegistration) => Disposer;
	readonly registerTool: (tool: ToolRegistration) => Disposer;
	readonly registerProvider: (provider: ProviderRegistration) => Disposer;
	readonly registerSubagent: (subagent: SubagentRegistration) => Disposer;
	readonly registerTuiOverlay: (overlay: TuiOverlayRegistration) => Disposer;
	readonly registerWeb: (web: WebRegistration) => Disposer;
}

export interface ExtensionContext {
	readonly apiVersion: ExtensionApiVersion;
	readonly extensionId: ExtensionId;
	readonly signal: AbortSignal;
	readonly session: SessionService;
	readonly files: FileService;
	readonly subprocess: SubprocessService;
	readonly network: NetworkService;
	readonly subagents: SubagentService;
	readonly ui: UiService;
	readonly settings: SettingsService;
	readonly diagnostics: DiagnosticsService;
	readonly sessions: SessionsService;
	readonly providers: ProvidersService;
	readonly jobs: JobsService;
}

export interface CommandInput {
	readonly args: string;
	readonly sessionId?: SessionId;
}
export interface CommandOutput {
	readonly version: 1;
	readonly text: string;
	readonly data?: JsonValue;
}
export interface CommandRegistration {
	readonly name: string;
	readonly description: string;
	readonly run: (input: CommandInput, options: OperationOptions) => Promise<CommandOutput>;
	readonly timeoutMs?: number;
}

export interface ToolInput {
	readonly toolCallId: string;
	readonly parameters: JsonValue;
	readonly sessionId?: SessionId;
}
export interface ToolOutput {
	readonly version: 1;
	readonly content: JsonValue;
	readonly truncated: boolean;
}
export interface JsonSchema {
	readonly type: "object";
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly required: readonly string[];
	readonly additionalProperties: boolean;
}
export interface ToolRegistration {
	readonly name: string;
	readonly description: string;
	readonly schema: JsonSchema;
	readonly execute: (input: ToolInput, options: OperationOptions) => Promise<ToolOutput>;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

export interface ProviderRequest {
	readonly requestId: RequestId;
	readonly model: string;
	readonly messages: readonly JsonValue[];
	readonly tools: readonly JsonSchema[];
}
export type ProviderEvent =
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "tool_call"; readonly toolCallId: string; readonly name: string; readonly arguments: JsonValue }
	| { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number }
	| { readonly type: "completed"; readonly stopReason: "stop" | "tool" | "length" }
	| { readonly type: "failed"; readonly code: "FAILED" | "CANCELLED" | "TIMEOUT"; readonly message: string };
export interface ProviderRegistration {
	readonly id: string;
	readonly models: readonly string[];
	readonly request: (input: ProviderRequest, options: OperationOptions) => AsyncIterable<ProviderEvent>;
}

export interface SubagentRegistration {
	readonly name: string;
	readonly description: string;
	readonly run: (input: SubagentStartInput, options: OperationOptions) => Promise<TaskResult>;
}

export interface TuiOverlayRegistration {
	readonly name: string;
	readonly render: (input: JsonValue) => string | readonly string[];
}

export interface SessionSnapshot {
	readonly version: 1;
	readonly id: SessionId;
	readonly cwd: string;
	readonly entryCount: number;
}
export interface SessionService {
	readonly id: SessionId;
	readonly snapshot: () => Promise<SessionSnapshot>;
	readonly append: (
		record: SessionPluginRecord,
		options?: OperationOptions,
	) => Promise<{ readonly version: 1; readonly sequence: number }>;
}

export interface FileReadInput {
	readonly path: string;
	readonly encoding?: "utf8" | "buffer";
}
export interface FileReadOutput {
	readonly version: 1;
	readonly path: string;
	readonly content: string;
	readonly truncated: boolean;
}
export interface FileService {
	readonly read: (input: FileReadInput, options?: OperationOptions) => Promise<FileReadOutput>;
	readonly write: (
		input: { readonly path: string; readonly content: string; readonly mode: "overwrite" | "append" },
		options?: OperationOptions,
	) => Promise<{ readonly version: 1; readonly bytesWritten: number }>;
}

export interface SubprocessService {
	readonly run: (
		input: {
			readonly command: string;
			readonly args: readonly string[];
			readonly cwd?: string;
			readonly maxOutputBytes?: number;
		},
		options?: OperationOptions,
	) => Promise<{
		readonly version: 1;
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;
		readonly truncated: boolean;
	}>;
}
export interface NetworkService {
	readonly fetch: (
		input: { readonly url: string; readonly method: "GET" | "POST"; readonly body?: JsonValue },
		options?: OperationOptions,
	) => Promise<{ readonly version: 1; readonly status: number; readonly body: JsonValue }>;
}

export type TaskState =
	| "starting"
	| "running"
	| "waiting"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "needs_reconciliation";
export interface TaskResult {
	readonly version: 1;
	readonly taskId: TaskId;
	readonly text: string;
	readonly data?: JsonValue;
}
export interface TaskEvent {
	readonly version: 1;
	readonly taskId: TaskId;
	readonly sequence: number;
	readonly type: "started" | "text_delta" | "tool_call" | "waiting" | "completed" | "failed" | "cancelled";
	readonly data?: JsonValue;
}
export interface TaskSnapshot {
	readonly version: 1;
	readonly taskId: TaskId;
	readonly state: TaskState;
	readonly sequence: number;
	readonly label: string;
	readonly sessionId?: SessionId;
}
export interface SubagentStartInput {
	readonly prompt: string;
	readonly label: string;
	readonly sessionId?: SessionId;
	readonly mode?: "run" | "continuable";
	readonly idempotencyKey?: string;
}
export interface SubagentRun {
	readonly taskId: TaskId;
	readonly state: TaskState;
	readonly result: Promise<TaskResult>;
	readonly events: AsyncIterable<TaskEvent>;
	readonly followup: (prompt: string, options?: OperationOptions) => Promise<TaskSnapshot>;
	readonly cancel: (options?: OperationOptions) => Promise<TaskSnapshot>;
}
export type ReconcileDecision =
	| { readonly type: "resume"; readonly confirmedStopped: true }
	| { readonly type: "complete"; readonly result: TaskResult }
	| { readonly type: "cancel"; readonly reason: string };
export interface TaskReconcileInput {
	readonly taskId: TaskId;
	readonly idempotencyKey: string;
	readonly decision: ReconcileDecision;
}
export interface TaskReconcileResult {
	readonly version: 1;
	readonly taskId: TaskId;
	readonly state: TaskState;
	readonly sequence: number;
	readonly idempotencyKey: string;
}
export interface SubagentService {
	readonly start: (input: SubagentStartInput, options?: OperationOptions) => Promise<SubagentRun>;
	readonly get: (taskId: TaskId, options?: OperationOptions) => Promise<TaskSnapshot>;
	readonly reconcileTask: (input: TaskReconcileInput, options?: OperationOptions) => Promise<TaskReconcileResult>;
}

export interface UiCustomInput {
	readonly title: string;
	readonly body: JsonValue;
	readonly sessionId?: SessionId;
}
export interface UiCustomResult {
	readonly version: 1;
	readonly closed: boolean;
	readonly reason: "submitted" | "cancelled" | "disposed";
	readonly value?: JsonValue;
}
export interface UiService {
	readonly custom: (input: UiCustomInput, options?: OperationOptions) => Promise<UiCustomResult>;
	readonly notify: (
		input: { readonly level: "info" | "warning" | "error"; readonly message: string },
		options?: OperationOptions,
	) => Promise<void>;
}
export interface SettingsService {
	readonly get: (
		key: string,
		options?: OperationOptions,
	) => Promise<{ readonly version: 1; readonly key: string; readonly value: JsonValue | undefined }>;
}
export interface DiagnosticsService {
	readonly report: (input: {
		readonly level: "info" | "warning" | "error";
		readonly code: string;
		readonly message: string;
		readonly details?: JsonValue;
	}) => void;
}

export interface SessionsService {
	readonly get: (sessionId: SessionId, options?: OperationOptions) => Promise<SessionSnapshot>;
	readonly list: (options?: OperationOptions) => Promise<readonly SessionSnapshot[]>;
}
export interface ProvidersService {
	readonly list: (
		options?: OperationOptions,
	) => Promise<readonly { readonly id: string; readonly models: readonly string[] }[]>;
	readonly get: (
		id: string,
		options?: OperationOptions,
	) => Promise<{ readonly id: string; readonly models: readonly string[] }>;
	readonly request: (
		providerId: string,
		input: ProviderRequest,
		options?: OperationOptions,
	) => AsyncIterable<ProviderEvent>;
}
export interface JobStartInput {
	readonly sessionId: SessionId;
	readonly kind: string;
	readonly input: JsonValue;
}
export interface JobHandle {
	readonly version: 1;
	readonly jobId: string;
	readonly state: "queued" | "running" | "completed" | "failed" | "cancelled";
	readonly result: Promise<JsonValue>;
	readonly cancel: (options?: OperationOptions) => Promise<void>;
}
export interface JobsService {
	readonly start: (input: JobStartInput, options?: OperationOptions) => Promise<JobHandle>;
	readonly get: (
		jobId: string,
		options?: OperationOptions,
	) => Promise<{
		readonly version: 1;
		readonly jobId: string;
		readonly state: "queued" | "running" | "completed" | "failed" | "cancelled";
	}>;
	readonly cancel: (jobId: string, options?: OperationOptions) => Promise<void>;
}

export interface SessionPluginRecord {
	readonly type: "plugin";
	readonly version: 1;
	readonly sequence: number;
	readonly timestamp: string;
	readonly sessionId: SessionId;
	readonly namespace: string;
	readonly eventName: string;
	readonly schemaVersion: number;
	readonly payload: JsonValue;
}

export interface WebRegistration {
	readonly entry: string;
	readonly integrity: `sha256-${string}`;
	readonly slots: readonly string[];
}
export interface ProjectionEnvelope {
	readonly protocolVersion: ExtensionProtocolVersion;
	readonly namespace: string;
	readonly schemaVersion: number;
	readonly value: JsonValue;
}
export type HostMessage =
	| {
			readonly type: "hello";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly nonce: string;
			readonly pluginId: ExtensionId;
			readonly sessionId?: SessionId;
	  }
	| {
			readonly type: "snapshot";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly sequence: number;
			readonly projection: readonly ProjectionEnvelope[];
	  }
	| {
			readonly type: "event";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly sequence: number;
			readonly projection: ProjectionEnvelope;
	  }
	| {
			readonly type: "action_result";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly requestId: RequestId;
			readonly ok: boolean;
			readonly value?: JsonValue;
			readonly errorCode?: ExtensionErrorCode;
	  }
	| {
			readonly type: "snapshot_required";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly reason: string;
	  };
export type BundleMessage =
	| {
			readonly type: "ready";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly nonce: string;
	  }
	| {
			readonly type: "action";
			readonly protocolVersion: ExtensionProtocolVersion;
			readonly instanceId: string;
			readonly requestId: RequestId;
			readonly action: string;
			readonly input: JsonValue;
	  };

export interface PackageIntegritySpec {
	readonly algorithm: "sha256";
	readonly encoding: "base64";
	readonly canonicalization: "path-length-framing-v1";
	readonly value: `sha256-${string}`;
}
export interface PluginManifestV1 {
	readonly apiVersion: ExtensionApiVersion;
	readonly id: ExtensionId;
	readonly version: string;
	readonly entry: string;
	readonly packageIntegrity: `sha256-${string}`;
	readonly permissions: readonly string[];
	readonly web?: { readonly entry: string; readonly integrity: `sha256-${string}`; readonly slots: readonly string[] };
}
export interface PluginTrustRecord {
	readonly version: 1;
	readonly pluginId: ExtensionId;
	readonly source: string;
	readonly resolvedVersion: string;
	readonly packageIntegrity: `sha256-${string}`;
	readonly trustedAt: string;
	readonly revokedAt?: string;
}

export interface PluginSetup {
	readonly default: (api: ExtensionAPI) => void | Promise<void>;
}

const taskTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
	starting: ["running", "needs_reconciliation", "completed", "failed", "cancelled", "timed_out"],
	running: ["waiting", "needs_reconciliation", "completed", "failed", "cancelled", "timed_out"],
	waiting: ["running", "needs_reconciliation", "completed", "failed", "cancelled", "timed_out"],
	completed: [],
	failed: [],
	cancelled: [],
	timed_out: [],
	needs_reconciliation: ["waiting", "completed", "cancelled"],
};

/** Returns whether a persisted task transition is legal in protocol version 1. */
export function isTaskStateTransitionAllowed(from: TaskState, to: TaskState): boolean {
	return taskTransitions[from].includes(to);
}
