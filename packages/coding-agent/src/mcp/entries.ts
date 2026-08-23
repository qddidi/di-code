import type { AgentTool } from "@di-code/agent";
import {
	type McpClient,
	type McpConnectedServer,
	McpManager,
	type McpManagerOptions,
	type McpServerConfig,
	StdioMcpClient,
	StreamableHttpMcpClient,
} from "@di-code/mcp";
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
	/** Releases a connected manager before the owning Fiber is disposed. */
	readonly close: (manager: McpManager) => Promise<void>;
}

export interface McpToolService {
	readonly create: (servers: readonly McpConnectedServer[], reservedNames?: Iterable<string>) => readonly AgentTool[];
}

export interface McpTransportRegistry {
	readonly register: (type: "stdio" | "streamable-http", create: (config: McpServerConfig) => McpClient) => () => void;
	readonly create: (config: McpServerConfig) => McpClient;
	readonly snapshot: () => readonly string[];
}

export const mcpConfigServiceKey = createServiceKey<McpConfigService>("mcp-config");
export const mcpClientServiceKey = createServiceKey<McpClientService>("mcp-client");
export const mcpToolServiceKey = createServiceKey<McpToolService>("mcp-tools");
export const mcpTransportRegistryKey = createServiceKey<McpTransportRegistry>("mcp-transports");

/** Loads MCP configuration through the composition service while retaining config boundary validation. */
export const mcpConfig: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-config",
	version: "0.1.7",
	apply(context) {
		context.set(mcpConfigServiceKey, { load: loadEffectiveMcpConfig });
	},
};

export const mcpTransport: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-transport",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const transports = new Map<"stdio" | "streamable-http", (config: McpServerConfig) => McpClient>();
		const registry: McpTransportRegistry = {
			register(type, create) {
				if (transports.has(type)) throw new Error(`Duplicate MCP transport: ${type}`);
				transports.set(type, create);
				return () => {
					if (transports.get(type) === create) transports.delete(type);
				};
			},
			create(config) {
				const factory = transports.get(config.transport.type);
				if (!factory) throw new Error(`MCP transport is unavailable: ${config.transport.type}`);
				return factory(config);
			},
			snapshot: () => Object.freeze([...transports.keys()]),
		};
		context.set(mcpTransportRegistryKey, registry);
		fiber.addDisposer(registry.register("stdio", (config) => new StdioMcpClient(config)));
		fiber.addDisposer(registry.register("streamable-http", (config) => new StreamableHttpMcpClient(config)));
	},
};

/** Owns managers created by this entry and closes any remaining connection during Fiber disposal. */
export const mcpClient: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-client",
	version: "0.1.7",
	apply(context, _config, fiber) {
		context.require(mcpConfigServiceKey);
		const transportRegistry = context.require(mcpTransportRegistryKey);
		const managers = new Set<McpManager>();
		const close = async (manager: McpManager): Promise<void> => {
			if (!managers.delete(manager)) return;
			await manager.close();
		};
		context.set(mcpClientServiceKey, {
			async connect(configurations, options = {}) {
				const manager = new McpManager({
					onServerConnectionStatus: options.onServerConnectionStatus,
					createClient: (config) => transportRegistry.create(config),
				});
				managers.add(manager);
				try {
					const result = await manager.connect(configurations, options.signal);
					return { manager, ...result };
				} catch (cause) {
					await close(manager);
					throw cause;
				}
			},
			close,
		});
		fiber.addDisposer(async () => {
			const results = await Promise.allSettled([...managers].map(close));
			const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (failures.length > 0) throw new AggregateError(failures, "Failed to close MCP managers");
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
