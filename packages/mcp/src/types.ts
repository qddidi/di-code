export interface McpStdioTransportConfig {
	readonly type: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export type McpTransportConfig = McpStdioTransportConfig;

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

export interface McpClient {
	connect(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<readonly McpTool[]>;
	callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
	close(): Promise<void>;
}

export interface McpDiagnostic {
	readonly serverId: string;
	readonly stage: "connect" | "list_tools" | "close";
	readonly message: string;
}

export interface McpConnectedServer {
	readonly config: McpServerConfig;
	readonly client: McpClient;
	readonly tools: readonly McpTool[];
}
