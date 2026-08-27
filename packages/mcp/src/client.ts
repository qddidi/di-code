import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpError, redactMcpDiagnostic } from "./errors.ts";
import type {
	McpClient,
	McpClientEventListener,
	McpProgress,
	McpPrompt,
	McpPromptResult,
	McpRequestOptions,
	McpResource,
	McpResourceContent,
	McpServerConfig,
	McpTool,
	McpToolResult,
} from "./types.ts";

// stdio servers launched through npx may need to resolve packages before initialize responds.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 4 * 1024;

function requestOptions(signal: AbortSignal | undefined, timeout: number): { signal?: AbortSignal; timeout: number } {
	return signal ? { signal, timeout } : { timeout };
}

function normalizeOptions(options: AbortSignal | McpRequestOptions | undefined, timeout: number): McpRequestOptions {
	return options instanceof AbortSignal ? { signal: options, timeoutMs: timeout } : { timeoutMs: timeout, ...options };
}

function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

export class StdioMcpClient implements McpClient {
	private readonly config: McpServerConfig;
	private readonly client: Client;
	private readonly transport: Transport & { close?: () => Promise<void> };
	private stderr = "";
	private state: "new" | "connected" | "closed" = "new";
	private readonly listeners = new Set<McpClientEventListener>();

	constructor(config: McpServerConfig) {
		this.config = config;
		this.client = new Client(
			{ name: "di-code", version: "0.1.4" },
			{
				capabilities: {},
				listChanged: {
					tools: {
						onChanged: (_error, tools) =>
							this.emit({ type: "tools_changed", tools: (tools ?? []).map((tool) => this.toTool(tool)) }),
					},
					resources: {
						onChanged: (_error, resources) =>
							this.emit({
								type: "resources_changed",
								resources: (resources ?? []).map((resource) => this.toResource(resource)),
							}),
					},
					prompts: {
						onChanged: (_error, prompts) =>
							this.emit({ type: "prompts_changed", prompts: (prompts ?? []).map((prompt) => this.toPrompt(prompt)) }),
					},
				},
			},
		);
		this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
			this.emit({ type: "resource_updated", uri: notification.params.uri });
		});
		if (config.transport.type === "stdio") {
			const transport = new StdioClientTransport({
				command: config.transport.command,
				args: config.transport.args ? [...config.transport.args] : undefined,
				cwd: config.transport.cwd,
				env: config.transport.env ? { ...config.transport.env } : undefined,
				stderr: "pipe",
				maxBufferSize: 1024 * 1024,
			});
			this.transport = transport;
			transport.stderr?.on("data", (chunk: Buffer) => {
				const remaining = MAX_STDERR_BYTES - Buffer.byteLength(this.stderr, "utf8");
				if (remaining > 0) this.stderr += chunk.subarray(0, remaining).toString("utf8");
			});
		} else {
			let url: URL;
			try {
				url = new URL(config.transport.url);
			} catch (cause) {
				throw new McpError("protocol", config.id, "transport URL must be an absolute http or https URL", { cause });
			}
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new McpError("protocol", config.id, "transport URL must use http or https");
			if (url.username || url.password)
				throw new McpError("protocol", config.id, "transport URL must not contain credentials");
			this.transport = new StreamableHTTPClientTransport(url, {
				requestInit: config.transport.headers ? { headers: { ...config.transport.headers } } : undefined,
			});
		}
		this.transport.onerror = (cause) => {
			this.markClosed();
			void cause;
		};
		this.transport.onclose = () => {
			this.markClosed();
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
		if (!this.client.getServerCapabilities()?.tools) return [];
		try {
			const tools: McpTool[] = [];
			let cursor: string | undefined;
			do {
				const result = await this.client.listTools(
					cursor ? { cursor } : {},
					requestOptions(signal, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
				);
				tools.push(...result.tools.map((tool) => this.toTool(tool)));
				cursor = result.nextCursor;
			} while (cursor !== undefined);
			return tools;
		} catch (cause) {
			throw this.error("protocol", cause);
		}
	}

	async callTool(
		name: string,
		argumentsValue: Record<string, unknown>,
		options?: AbortSignal | McpRequestOptions,
	): Promise<McpToolResult> {
		this.assertConnected();
		try {
			const request = normalizeOptions(options, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
			const result = await this.client.callTool({ name, arguments: argumentsValue }, undefined, {
				signal: request.signal,
				timeout: request.timeoutMs,
				maxTotalTimeout: request.maxTotalTimeoutMs,
				onprogress: request.onProgress ? (progress) => request.onProgress?.(progress as McpProgress) : undefined,
			});
			return {
				content: Array.isArray(result.content) ? result.content : [],
				...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
				isError: result.isError === true,
			};
		} catch (cause) {
			throw this.error("tool", cause);
		}
	}

	async listResources(options?: McpRequestOptions): Promise<readonly McpResource[]> {
		this.assertConnected();
		if (!this.client.getServerCapabilities()?.resources) return [];
		try {
			const resources: McpResource[] = [];
			let cursor: string | undefined;
			do {
				const request = normalizeOptions(options, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
				const result = await this.client.listResources(cursor ? { cursor } : {}, {
					signal: request.signal,
					timeout: request.timeoutMs,
					maxTotalTimeout: request.maxTotalTimeoutMs,
					onprogress: request.onProgress ? (progress) => request.onProgress?.(progress as McpProgress) : undefined,
				});
				resources.push(...result.resources.map((resource) => this.toResource(resource)));
				cursor = result.nextCursor;
			} while (cursor !== undefined);
			return resources;
		} catch (cause) {
			throw this.error("protocol", cause);
		}
	}

	async readResource(uri: string, options?: McpRequestOptions): Promise<readonly McpResourceContent[]> {
		this.assertConnected();
		try {
			const request = normalizeOptions(options, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
			const result = await this.client.readResource(
				{ uri },
				{
					signal: request.signal,
					timeout: request.timeoutMs,
					maxTotalTimeout: request.maxTotalTimeoutMs,
					onprogress: request.onProgress ? (progress) => request.onProgress?.(progress as McpProgress) : undefined,
				},
			);
			return result.contents.map((item) =>
				"text" in item
					? { uri: item.uri, text: item.text, ...(item.mimeType ? { mimeType: item.mimeType } : {}) }
					: { uri: item.uri, blob: item.blob, ...(item.mimeType ? { mimeType: item.mimeType } : {}) },
			);
		} catch (cause) {
			throw this.error("protocol", cause);
		}
	}

	async listPrompts(options?: McpRequestOptions): Promise<readonly McpPrompt[]> {
		this.assertConnected();
		if (!this.client.getServerCapabilities()?.prompts) return [];
		try {
			const prompts: McpPrompt[] = [];
			let cursor: string | undefined;
			do {
				const request = normalizeOptions(options, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
				const result = await this.client.listPrompts(cursor ? { cursor } : {}, {
					signal: request.signal,
					timeout: request.timeoutMs,
					maxTotalTimeout: request.maxTotalTimeoutMs,
					onprogress: request.onProgress ? (progress) => request.onProgress?.(progress as McpProgress) : undefined,
				});
				prompts.push(...result.prompts.map((prompt) => this.toPrompt(prompt)));
				cursor = result.nextCursor;
			} while (cursor !== undefined);
			return prompts;
		} catch (cause) {
			throw this.error("protocol", cause);
		}
	}

	async getPrompt(
		name: string,
		argumentsValue: Record<string, string> = {},
		options?: McpRequestOptions,
	): Promise<McpPromptResult> {
		this.assertConnected();
		try {
			const request = normalizeOptions(options, this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
			const result = await this.client.getPrompt(
				{ name, arguments: argumentsValue },
				{
					signal: request.signal,
					timeout: request.timeoutMs,
					maxTotalTimeout: request.maxTotalTimeoutMs,
					onprogress: request.onProgress ? (progress) => request.onProgress?.(progress as McpProgress) : undefined,
				},
			);
			return {
				...(result.description ? { description: result.description } : {}),
				messages: result.messages as McpPromptResult["messages"],
			};
		} catch (cause) {
			throw this.error("protocol", cause);
		}
	}

	on(listener: McpClientEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.markClosed();
		await this.client.close().catch(() => this.transport.close().catch(() => undefined));
	}

	private emit(event: Parameters<McpClientEventListener>[0]): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* observers must not break transport */
			}
		}
	}

	private markClosed(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.emit({ type: "closed" });
	}

	private toTool(tool: { name: string; description?: string; inputSchema?: unknown }): McpTool {
		return {
			name: tool.name,
			...(tool.description === undefined ? {} : { description: tool.description }),
			inputSchema: asObject(tool.inputSchema),
			serverId: this.config.id,
		};
	}

	private toResource(resource: {
		uri: string;
		name: string;
		description?: string;
		mimeType?: string;
		size?: number;
	}): McpResource {
		return {
			uri: resource.uri,
			name: resource.name,
			...(resource.description === undefined ? {} : { description: resource.description }),
			...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
			...(resource.size === undefined ? {} : { size: resource.size }),
			serverId: this.config.id,
		};
	}

	private toPrompt(prompt: {
		name: string;
		description?: string;
		arguments?: { name: string; description?: string; required?: boolean }[];
	}): McpPrompt {
		return {
			name: prompt.name,
			...(prompt.description === undefined ? {} : { description: prompt.description }),
			...(prompt.arguments === undefined ? {} : { arguments: prompt.arguments }),
			serverId: this.config.id,
		};
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
		const status =
			typeof cause === "object" && cause !== null && "code" in cause ? (cause as { code?: unknown }).code : undefined;
		const kind =
			status === 401 || status === 403 || /(?:unauthorized|forbidden|authentication)/i.test(message)
				? "authentication"
				: /timeout/i.test(message)
					? "timeout"
					: fallback;
		return new McpError(kind, this.config.id, `${message || "request failed"}${stderr}`, { cause });
	}
}

/** MCP client backed by Streamable HTTP. The transport is selected from the server config. */
export class StreamableHttpMcpClient extends StdioMcpClient {}
