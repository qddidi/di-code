export interface BootData {
	readonly protocolVersion: number;
	readonly capabilities: {
		readonly methods: readonly string[];
		readonly events: readonly string[];
		readonly eventBufferSize?: number;
	};
	readonly state: { readonly modelId: string; readonly messageCount: number };
	readonly runtime: { readonly providerId: string; readonly modelId: string };
	readonly workspaceId: string;
	readonly workspaces: readonly WorkspaceSummary[];
}

export interface WorkspaceSummary {
	readonly id: string;
	readonly name: string;
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

export type ToolStatus = "loading" | "success" | "error" | "cancelled" | "timeout" | "truncated";

export interface ToolTrace {
	readonly id: string;
	readonly name: "read" | "write" | "edit" | "bash" | "glob" | "grep" | string;
	readonly arguments: Record<string, unknown>;
	readonly output?: string;
	readonly images?: readonly ConversationImage[];
	readonly details?: Record<string, unknown>;
	readonly status: ToolStatus;
	readonly error?: string;
}

export type ConversationActivity =
	| { readonly id: string; readonly kind: "thinking"; readonly text: string }
	| { readonly id: string; readonly kind: "tool"; readonly tool: ToolTrace };

export interface ConversationMessage {
	readonly role: "user" | "assistant" | "tool";
	readonly text: string;
	/** The expanded Skill prompt is kept out of the conversation projection. */
	readonly skillName?: string;
	readonly images?: readonly ConversationImage[];
	readonly thinking?: string;
	readonly activities?: readonly ConversationActivity[];
	readonly status?: string;
	/** Durable Session record used to branch exactly at this message. */
	readonly entryId?: string;
}

export interface ConversationImage {
	readonly src: string;
	readonly mimeType: string;
	readonly alt: string;
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
		readonly models: readonly {
			readonly id: string;
			readonly name: string;
			readonly input: readonly string[];
			readonly reasoningEfforts?: readonly ("low" | "medium" | "high" | "max")[];
		}[];
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

export interface SkillSummary {
	readonly name: string;
	readonly description: string;
	readonly scope: string;
}
export interface CommandSummary {
	readonly name: string;
	readonly description: string;
	readonly kind: "command" | "skill";
}
export interface CommandAction {
	readonly command: string;
	readonly args: string;
}
export interface SessionTreeEntry {
	readonly id: string;
	readonly type: "message" | "summary" | "plugin";
	readonly timestamp: string;
	readonly summary?: string;
	readonly pluginId?: string;
	readonly message?: {
		readonly role: "user" | "assistant" | "tool_result";
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly stopReason?: string;
	};
}
export interface SessionTreeNode {
	readonly entry: SessionTreeEntry;
	readonly children: readonly SessionTreeNode[];
}
export interface TreeNavigation {
	readonly editorText?: string;
	readonly selectedEntryId: string;
	readonly leafId: string;
	readonly imagesOmitted: boolean;
}
export interface McpServerSummary {
	readonly id: string;
	readonly scope?: string;
	readonly state: "configured" | "connected" | "failed" | "disconnected";
	readonly tools: number;
	readonly resources: number;
	readonly prompts: number;
	readonly diagnostic?: string;
}
export interface PluginSummary {
	readonly id: string;
	readonly version: string;
	readonly enabled: boolean;
	readonly installedAt: string;
	readonly capabilities: readonly string[];
	readonly source?: "managed" | "project";
	readonly status?: "pending" | "active" | "failed" | "skipped" | "disabled";
	readonly error?: string;
}

export type WebSlotId =
	| "app.sidebar"
	| "session.tree"
	| "conversation.node"
	| "conversation.tool"
	| "settings.panel"
	| "session.badge"
	| "session.controls"
	| "review.panel"
	| "composer.placeholder";
export interface WebContribution {
	readonly id: string;
	readonly slot: WebSlotId | string;
	readonly version: 1;
	readonly order?: number;
	readonly capability?: string;
	readonly componentKey: string;
	readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}
export interface WebManifest {
	readonly protocolVersion: 1;
	readonly contributions: readonly WebContribution[];
}
