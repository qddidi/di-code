import { StdioMcpClient } from "./client.ts";
import { redactMcpDiagnostic } from "./errors.ts";
import type { McpClient, McpConnectedServer, McpDiagnostic, McpServerConfig } from "./types.ts";

export interface McpManagerOptions {
	readonly createClient?: (config: McpServerConfig) => McpClient;
}

/** Owns all server connections for one coding-agent runtime. */
export class McpManager {
	private readonly createClient: (config: McpServerConfig) => McpClient;
	private connected: McpConnectedServer[] = [];

	constructor(options: McpManagerOptions = {}) {
		this.createClient = options.createClient ?? ((config) => new StdioMcpClient(config));
	}

	async connect(
		configurations: readonly McpServerConfig[],
		signal?: AbortSignal,
	): Promise<{ servers: readonly McpConnectedServer[]; diagnostics: readonly McpDiagnostic[] }> {
		const results = await Promise.all(
			configurations.map(async (config) => {
				const client = this.createClient(config);
				try {
					await client.connect(signal);
				} catch (cause) {
					await client.close().catch(() => undefined);
					return {
						diagnostic: { serverId: config.id, stage: "connect" as const, message: redactMcpDiagnostic(cause) },
					};
				}
				try {
					const tools = await client.listTools(signal);
					return { server: { config, client, tools } satisfies McpConnectedServer };
				} catch (cause) {
					await client.close().catch(() => undefined);
					return {
						diagnostic: { serverId: config.id, stage: "list_tools" as const, message: redactMcpDiagnostic(cause) },
					};
				}
			}),
		);
		this.connected = results.reduce<McpConnectedServer[]>((servers, result) => {
			if (result.server !== undefined) servers.push(result.server);
			return servers;
		}, []);
		const diagnostics = results.reduce<McpDiagnostic[]>((items, result) => {
			if (result.diagnostic !== undefined) items.push(result.diagnostic);
			return items;
		}, []);
		return { servers: [...this.connected], diagnostics };
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
