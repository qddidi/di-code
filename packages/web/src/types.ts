export interface BootData {
	readonly protocolVersion: number;
	readonly capabilities: { readonly methods: readonly string[]; readonly events: readonly string[] };
	readonly state: { readonly modelId: string; readonly messageCount: number };
	readonly runtime: { readonly providerId: string; readonly modelId: string };
}

export interface SessionSummary {
	readonly id: string;
	readonly label: string;
	readonly modifiedAt?: string;
	readonly stats?: { readonly entryCount: number; readonly messageCount: number; readonly branchCount: number };
}

export interface RpcEnvelope<T> {
	readonly ok: boolean;
	readonly result?: T;
	readonly error?: { readonly message?: string };
}

export interface ConversationMessage {
	readonly role: "user" | "assistant" | "tool";
	readonly text: string;
	readonly thinking?: string;
	readonly status?: string;
}

export type ToolStatus = "loading" | "success" | "error" | "cancelled" | "timeout" | "truncated";

export interface ToolTrace {
	readonly id: string;
	readonly name: "read" | "write" | "edit" | "bash" | "glob" | "grep" | string;
	readonly arguments: Record<string, unknown>;
	readonly output?: string;
	readonly details?: Record<string, unknown>;
	readonly status: ToolStatus;
	readonly error?: string;
}

export interface ToolApproval {
	readonly approvalId: string;
	readonly requestId: string;
	readonly toolName?: string;
	readonly arguments?: Record<string, unknown>;
	readonly state: "pending" | "accepted" | "denied";
}

export interface ContextFile {
	readonly path: string;
	readonly scope: string;
	readonly bytes: number;
}

export interface AttachmentInfo {
	readonly id: string;
	readonly name: string;
	readonly contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	readonly bytes: number;
	readonly previewUrl?: string;
}

export interface OperationState {
	readonly requestId: string;
	readonly kind: string;
	readonly status: "queued" | "running" | "completed" | "failed" | "cancelled" | "crashed";
	readonly error?: { readonly code: string; readonly message: string };
}

export interface UsageSnapshot {
	readonly requestCount?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly cacheReadTokens?: number;
	readonly estimatedContextTokens?: number;
	readonly contextWindow?: number;
}

export interface SessionsResult {
	readonly method: "list_sessions";
	readonly sessions: readonly SessionSummary[];
}

export interface SettingsSnapshot {
	readonly providers: readonly {
		readonly id: string;
		readonly name: string;
		readonly models: readonly { readonly id: string; readonly name: string; readonly input: readonly string[] }[];
		readonly configured: boolean;
		readonly api: string;
		readonly baseUrl?: string;
		readonly apiKeySource: "environment" | "settings" | "missing";
	}[];
	readonly defaults: { readonly providerId?: string; readonly modelId?: string };
	readonly runtime: { readonly providerId: string; readonly modelId: string; readonly thinkingLevel?: string };
	readonly locale?: "en" | "zh-CN";
	readonly permissionMode: "ask" | "allow" | "deny";
	readonly sources: Readonly<Record<string, string>>;
}
