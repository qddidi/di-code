import type { AgentTool } from "@di-code/agent";
import { type McpConnectedServer, McpManager, type McpManagerOptions, type McpServerConfig } from "@di-code/mcp";
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";
import { loadEffectiveMcpConfig } from "./config.ts";
import { createMcpAgentTools } from "./tool-adapter.ts";

export interface McpConfigService {
	readonly load: (options: {
		readonly cwd: string;
		readonly homeDirectory?: string;
		readonly environment?: Readonly<Record<string, string | undefined>>;
		readonly projectTrusted: boolean;
	}) => Promise<readonly McpServerConfig[]>;
}

export interface McpClientService {
	readonly connect: (
		configurations: readonly McpServerConfig[],
		options?: Partial<Pick<McpManagerOptions, "onServerConnectionStatus">> & { readonly signal?: AbortSignal },
	) => Promise<{
		readonly manager: McpManager;
		readonly servers: readonly McpConnectedServer[];
		readonly diagnostics: Awaited<ReturnType<McpManager["connect"]>>["diagnostics"];
	}>;
}

export interface McpToolService {
	readonly create: (servers: readonly McpConnectedServer[], reservedNames?: Iterable<string>) => readonly AgentTool[];
}

export const mcpConfigServiceKey = createServiceKey<McpConfigService>("mcp-config");
export const mcpClientServiceKey = createServiceKey<McpClientService>("mcp-client");
export const mcpToolServiceKey = createServiceKey<McpToolService>("mcp-tools");

/** Loads MCP configuration through the composition service while retaining config boundary validation. */
export const mcpConfig: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-config",
	version: "0.1.7",
	apply(context) {
		context.set(mcpConfigServiceKey, { load: loadEffectiveMcpConfig });
	},
};

/** Owns a manager per connection attempt; callers retain and close the returned manager. */
export const mcpClient: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-client",
	version: "0.1.7",
	apply(context) {
		context.require(mcpConfigServiceKey);
		context.set(mcpClientServiceKey, {
			async connect(configurations, options = {}) {
				const manager = new McpManager({ onServerConnectionStatus: options.onServerConnectionStatus });
				try {
					const result = await manager.connect(configurations, options.signal);
					return { manager, ...result };
				} catch (cause) {
					await manager.close();
					throw cause;
				}
			},
		});
	},
};

/** Converts connected MCP capabilities into the single Agent ToolRegistry input surface. */
export const mcpTools: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-tools",
	version: "0.1.7",
	apply(context) {
		context.require(mcpConfigServiceKey);
		context.require(mcpClientServiceKey);
		context.set(mcpToolServiceKey, { create: createMcpAgentTools });
	},
};
