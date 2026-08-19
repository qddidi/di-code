export interface McpStdioTransportConfig {
	readonly type: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface McpStreamableHttpTransportConfig {
	readonly type: "streamable-http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export type McpTransportConfig = McpStdioTransportConfig | McpStreamableHttpTransportConfig;

export interface McpServerConfig {
	readonly id: string;
	readonly name?: string;
	readonly transport: McpTransportConfig;
	readonly connectTimeoutMs?: number;
	readonly callTimeoutMs?: number;
}

export interface McpTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: Record<string, unknown>;
	readonly serverId: string;
}

export interface McpToolResult {
	readonly content: readonly unknown[];
	readonly structuredContent?: unknown;
	readonly isError: boolean;
}

export interface McpResource {
	readonly uri: string;
	readonly name: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly size?: number;
	readonly serverId: string;
}

export type McpResourceContent =
	| { readonly uri: string; readonly text: string; readonly mimeType?: string }
	| { readonly uri: string; readonly blob: string; readonly mimeType?: string };

export interface McpPromptArgument {
	readonly name: string;
	readonly description?: string;
	readonly required?: boolean;
}

export interface McpPrompt {
	readonly name: string;
	readonly description?: string;
	readonly arguments?: readonly McpPromptArgument[];
	readonly serverId: string;
}

export type McpPromptContent = McpToolResult["content"][number];

export interface McpPromptMessage {
	readonly role: "user" | "assistant";
	readonly content: McpPromptContent;
}

export interface McpPromptResult {
	readonly description?: string;
	readonly messages: readonly McpPromptMessage[];
}

export interface McpProgress {
	readonly progressToken: string | number;
	readonly progress: number;
	readonly total?: number;
	readonly message?: string;
}

export interface McpRequestOptions {
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: McpProgress) => void;
	readonly timeoutMs?: number;
	readonly maxTotalTimeoutMs?: number;
}

export type McpClientEvent =
	| { readonly type: "tools_changed"; readonly tools: readonly McpTool[] }
	| { readonly type: "resources_changed"; readonly resources: readonly McpResource[] }
	| { readonly type: "prompts_changed"; readonly prompts: readonly McpPrompt[] }
	| { readonly type: "resource_updated"; readonly uri: string }
	| { readonly type: "closed" };

export type McpClientEventListener = (event: McpClientEvent) => void;

export interface McpClient {
	connect(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<readonly McpTool[]>;
	callTool(
		name: string,
		argumentsValue: Record<string, unknown>,
		options?: AbortSignal | McpRequestOptions,
	): Promise<McpToolResult>;
	listResources(options?: McpRequestOptions): Promise<readonly McpResource[]>;
	readResource(uri: string, options?: McpRequestOptions): Promise<readonly McpResourceContent[]>;
	listPrompts(options?: McpRequestOptions): Promise<readonly McpPrompt[]>;
	getPrompt(
		name: string,
		argumentsValue?: Record<string, string>,
		options?: McpRequestOptions,
	): Promise<McpPromptResult>;
	on(listener: McpClientEventListener): () => void;
	close(): Promise<void>;
}

export interface McpDiagnostic {
	readonly serverId: string;
	readonly stage: "connect" | "list_tools" | "list_resources" | "list_prompts" | "close" | "reconnect";
	readonly message: string;
}

/** A connection outcome emitted while a manager establishes its initial Server set. */
export type McpServerConnectionStatus =
	| { readonly serverId: string; readonly state: "connecting" }
	| {
			readonly serverId: string;
			readonly state: "connected";
			readonly tools: number;
			readonly resources: number;
			readonly prompts: number;
	  }
	| {
			readonly serverId: string;
			readonly state: "failed";
			readonly stage: Extract<McpDiagnostic["stage"], "connect" | "list_tools">;
			readonly message: string;
	  };

export interface McpConnectedServer {
	readonly config: McpServerConfig;
	readonly client: McpClient;
	readonly tools: readonly McpTool[];
	readonly resources: readonly McpResource[];
	readonly prompts: readonly McpPrompt[];
}
