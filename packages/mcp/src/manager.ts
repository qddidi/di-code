import { StdioMcpClient, StreamableHttpMcpClient } from "./client.ts";
import { redactMcpDiagnostic } from "./errors.ts";
import type {
	McpClient,
	McpConnectedServer,
	McpDiagnostic,
	McpServerConfig,
	McpServerConnectionStatus,
} from "./types.ts";

export interface McpManagerOptions {
	readonly createClient?: (config: McpServerConfig) => McpClient;
	/** Observes initial connection outcomes without changing connection behavior. */
	readonly onServerConnectionStatus?: (status: McpServerConnectionStatus) => void;
}

/** Owns all server connections for one coding-agent runtime. */
export class McpManager {
	private readonly createClient: (config: McpServerConfig) => McpClient;
	private readonly onServerConnectionStatus?: (status: McpServerConnectionStatus) => void;
	private connected: McpConnectedServer[] = [];

	constructor(options: McpManagerOptions = {}) {
		this.createClient =
			options.createClient ??
			((config) =>
				config.transport.type === "streamable-http" ? new StreamableHttpMcpClient(config) : new StdioMcpClient(config));
		this.onServerConnectionStatus = options.onServerConnectionStatus;
	}

	async connect(
		configurations: readonly McpServerConfig[],
		signal?: AbortSignal,
	): Promise<{ servers: readonly McpConnectedServer[]; diagnostics: readonly McpDiagnostic[] }> {
		const results = await Promise.all(
			configurations.map(async (config) => {
				const client = this.createClient(config);
				this.onServerConnectionStatus?.({ serverId: config.id, state: "connecting" });
				try {
					await client.connect(signal);
				} catch (cause) {
					await client.close().catch(() => undefined);
					const message = redactMcpDiagnostic(cause);
					this.onServerConnectionStatus?.({ serverId: config.id, state: "failed", stage: "connect", message });
					return {
						diagnostic: { serverId: config.id, stage: "connect" as const, message },
					};
				}
				try {
					const tools = await client.listTools(signal);
					const [resourceResult, promptResult] = await Promise.allSettled([
						client.listResources({ signal }),
						client.listPrompts({ signal }),
					]);
					const diagnostics: McpDiagnostic[] = [];
					if (resourceResult.status === "rejected")
						diagnostics.push({
							serverId: config.id,
							stage: "list_resources",
							message: redactMcpDiagnostic(resourceResult.reason),
						});
					if (promptResult.status === "rejected")
						diagnostics.push({
							serverId: config.id,
							stage: "list_prompts",
							message: redactMcpDiagnostic(promptResult.reason),
						});
					return {
						server: {
							config,
							client,
							tools,
							resources: resourceResult.status === "fulfilled" ? resourceResult.value : [],
							prompts: promptResult.status === "fulfilled" ? promptResult.value : [],
						} satisfies McpConnectedServer,
						diagnostics,
					};
				} catch (cause) {
					await client.close().catch(() => undefined);
					const message = redactMcpDiagnostic(cause);
					this.onServerConnectionStatus?.({ serverId: config.id, state: "failed", stage: "list_tools", message });
					return {
						diagnostic: { serverId: config.id, stage: "list_tools" as const, message },
					};
				}
			}),
		);
		for (const result of results) {
			if (result.server === undefined) continue;
			this.onServerConnectionStatus?.({
				serverId: result.server.config.id,
				state: "connected",
				tools: result.server.tools.length,
				resources: result.server.resources.length,
				prompts: result.server.prompts.length,
			});
		}
		this.connected = results.reduce<McpConnectedServer[]>((servers, result) => {
			if (result.server !== undefined) servers.push(result.server);
			return servers;
		}, []);
		const diagnostics = results.reduce<McpDiagnostic[]>((items, result) => {
			if (result.diagnostic !== undefined) items.push(result.diagnostic);
			if (result.diagnostics !== undefined) items.push(...result.diagnostics);
			return items;
		}, []);
		return { servers: [...this.connected], diagnostics };
	}

	/** Reconnects one server and refreshes its tools, resources, and prompts. */
	async reconnect(serverId: string, signal?: AbortSignal): Promise<McpConnectedServer> {
		const current = this.connected.find((server) => server.config.id === serverId);
		if (!current) throw new Error(`MCP server "${serverId}" is not connected.`);
		await current.client.close();
		const client = this.createClient(current.config);
		try {
			await client.connect(signal);
			const tools = await client.listTools(signal);
			const [resourceResult, promptResult] = await Promise.allSettled([
				client.listResources({ signal }),
				client.listPrompts({ signal }),
			]);
			const refreshed = {
				config: current.config,
				client,
				tools,
				resources: resourceResult.status === "fulfilled" ? resourceResult.value : [],
				prompts: promptResult.status === "fulfilled" ? promptResult.value : [],
			} satisfies McpConnectedServer;
			this.connected = this.connected.map((server) => (server.config.id === serverId ? refreshed : server));
			return refreshed;
		} catch (cause) {
			await client.close().catch(() => undefined);
			this.connected = this.connected.filter((server) => server.config.id !== serverId);
			throw new Error(redactMcpDiagnostic(cause), { cause });
		}
	}

	async close(): Promise<readonly McpDiagnostic[]> {
		const servers = this.connected.splice(0);
		const results = await Promise.all(
			servers.map(async (server) => {
				try {
					await server.client.close();
					return undefined;
				} catch (cause) {
					return { serverId: server.config.id, stage: "close" as const, message: redactMcpDiagnostic(cause) };
				}
			}),
		);
		return results.reduce<McpDiagnostic[]>((diagnostics, result) => {
			if (result !== undefined) diagnostics.push(result);
			return diagnostics;
		}, []);
	}
}
