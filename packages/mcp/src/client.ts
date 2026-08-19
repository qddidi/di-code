import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError, redactMcpDiagnostic } from "./errors.ts";
import type { McpClient, McpServerConfig, McpTool, McpToolResult } from "./types.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 4 * 1024;

function requestOptions(signal: AbortSignal | undefined, timeout: number): { signal?: AbortSignal; timeout: number } {
	return signal ? { signal, timeout } : { timeout };
}

function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

export class StdioMcpClient implements McpClient {
	private readonly config: McpServerConfig;
	private readonly client: Client;
	private readonly transport: StdioClientTransport;
	private stderr = "";
	private state: "new" | "connected" | "closed" = "new";

	constructor(config: McpServerConfig) {
		this.config = config;
		if (config.transport.type !== "stdio")
			throw new McpError("protocol", config.id, "only stdio transport is supported");
		this.client = new Client({ name: "di-code", version: "0.1.4" }, { capabilities: {} });
		this.transport = new StdioClientTransport({
			command: config.transport.command,
			args: config.transport.args ? [...config.transport.args] : undefined,
			cwd: config.transport.cwd,
			env: config.transport.env ? { ...config.transport.env } : undefined,
			stderr: "pipe",
			maxBufferSize: 1024 * 1024,
		});
		this.transport.stderr?.on("data", (chunk: Buffer) => {
			const remaining = MAX_STDERR_BYTES - Buffer.byteLength(this.stderr, "utf8");
			if (remaining > 0) this.stderr += chunk.subarray(0, remaining).toString("utf8");
		});
		this.transport.onerror = (cause) => {
			if (this.state !== "closed") this.state = "closed";
			void cause;
		};
		this.transport.onclose = () => {
			if (this.state !== "closed") this.state = "closed";
		};
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.state === "connected") return;
		if (this.state === "closed") throw new McpError("closed", this.config.id, "connection is closed");
		try {
			await this.client.connect(
				this.transport,
				requestOptions(signal, this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS),
			);
			this.state = "connected";
		} catch (cause) {
			await this.close();
			throw this.error("connection", cause);
		}
	}

	async listTools(signal?: AbortSignal): Promise<readonly McpTool[]> {
		this.assertConnected();
		try {
			const result = await this.client.listTools(
				{},
				requestOptions(signal, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
			);
			return result.tools.map((tool) => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				inputSchema: asObject(tool.inputSchema),
				serverId: this.config.id,
			}));
		} catch (cause) {
			throw this.error("protocol", cause);
		}
	}

	async callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		this.assertConnected();
		try {
			const result = await this.client.callTool(
				{ name, arguments: argumentsValue },
				undefined,
				requestOptions(signal, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
			);
			return {
				content: Array.isArray(result.content) ? result.content : [],
				...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
				isError: result.isError === true,
			};
		} catch (cause) {
			throw this.error("tool", cause);
		}
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.state = "closed";
		await this.client.close().catch(() => this.transport.close().catch(() => undefined));
	}

	private assertConnected(): void {
		if (this.state !== "connected")
			throw new McpError(this.state === "closed" ? "closed" : "connection", this.config.id, "is not connected");
	}

	private error(fallback: "connection" | "protocol" | "tool", cause: unknown): McpError {
		if (cause instanceof McpError) return cause;
		if (cause instanceof Error && cause.name === "AbortError")
			return new McpError("cancelled", this.config.id, "request cancelled", { cause });
		const message = redactMcpDiagnostic(cause instanceof Error ? cause.message : cause);
		const stderr = this.stderr ? `; stderr: ${redactMcpDiagnostic(this.stderr)}` : "";
		const kind = /timeout/i.test(message) ? "timeout" : fallback;
		return new McpError(kind, this.config.id, `${message || "request failed"}${stderr}`, { cause });
	}
}
