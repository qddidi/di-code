import { join } from "node:path";
import type { ModelApi, Provider } from "@di-code/ai";
import { providerRegistryKey } from "@di-code/builtins";
import type { McpManager } from "@di-code/mcp";
import { ProjectTrustStore } from "@di-code/plugin-loader";
import type { Context } from "@di-code/plugin-runtime";
import { addMcpConfig, listMcpConfig, type McpConfigScope, removeMcpConfig } from "../mcp/config.ts";
import { mcpClientServiceKey, mcpConfigServiceKey } from "../mcp/entries.ts";
import type { RpcContextFileInfo, RpcMcpServerInfo, RpcProviderSummary } from "../rpc/protocol.ts";
import { removeGlobalProviderApiKey, saveGlobalProviderApiKey } from "../startup.ts";
import { interactiveResourceServiceKey } from "./interactive-resource-service.ts";

export interface ProductHostOptions {
	readonly context: Context;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
	/** Current runtime is included even when a test or embeddable host supplied it outside the registry. */
	readonly provider?: Provider;
	/** Refreshes the owning SessionHost after a trust or MCP configuration change. */
	readonly refreshResources?: (projectTrusted?: boolean, signal?: AbortSignal) => Promise<void>;
}

export type ProductHostAuditAction =
	| "login"
	| "logout"
	| "set_project_trust"
	| "configure_mcp_server"
	| "remove_mcp_server"
	| "reconnect_mcp_server";

/** Redacted state-change notification for UI audit trails. */
export interface ProductHostEvent {
	readonly type: "product_audit";
	readonly action: ProductHostAuditAction;
	readonly target?: string;
	readonly projectTrusted?: boolean;
}
export type ProductHostListener = (event: ProductHostEvent) => void | Promise<void>;

export interface ProductHost {
	readonly state: () => { readonly projectTrusted: boolean };
	readonly listProviders: () => readonly RpcProviderSummary[];
	readonly login: (
		input: {
			readonly providerId: string;
			readonly apiKey: string;
			readonly modelId?: string;
			readonly api?: string;
		},
		signal?: AbortSignal,
	) => Promise<RpcProviderSummary>;
	readonly logout: (providerId: string, signal?: AbortSignal) => Promise<void>;
	readonly getProjectTrust: () => boolean;
	readonly setProjectTrust: (trusted: boolean, signal?: AbortSignal) => Promise<boolean>;
	readonly listContextFiles: (signal?: AbortSignal) => Promise<readonly RpcContextFileInfo[]>;
	readonly listMcpServers: (signal?: AbortSignal) => Promise<readonly RpcMcpServerInfo[]>;
	readonly configureMcpServer: (
		input: {
			readonly serverId: string;
			readonly scope: McpConfigScope;
			readonly config: Record<string, unknown>;
		},
		signal?: AbortSignal,
	) => Promise<RpcMcpServerInfo>;
	readonly removeMcpServer: (serverId: string, scope: McpConfigScope, signal?: AbortSignal) => Promise<void>;
	readonly reconnectMcpServer: (serverId: string, signal?: AbortSignal) => Promise<RpcMcpServerInfo>;
	readonly subscribe: (listener: ProductHostListener) => () => void;
	readonly dispose: () => Promise<void>;
}

const API_BY_PROVIDER: Readonly<Record<string, Exclude<ModelApi, "faux">>> = {
	openai: "openai-responses",
	deepseek: "openai-chat-completions",
	kimi: "openai-chat-completions",
	zhipu: "openai-chat-completions",
	anthropic: "anthropic-messages",
};

export function createProductHost(options: ProductHostOptions): ProductHost {
	let projectTrusted = options.projectTrusted;
	let manager: McpManager | undefined;
	let connected = new Map<string, { tools: number; resources: number; prompts: number }>();
	let disposed = false;
	const listeners = new Set<ProductHostListener>();
	const trustStore = new ProjectTrustStore(join(options.agentDir, "trust.json"));
	const registry = options.context.require(providerRegistryKey);
	const ensureOpen = (): void => {
		if (disposed) throw new Error("ProductHost has been disposed.");
	};
	const throwIfAborted = (signal: AbortSignal | undefined): void => {
		if (signal?.aborted) throw signal.reason ?? new Error("ProductHost operation was cancelled.");
	};
	const emitAudit = (event: Omit<ProductHostEvent, "type">): void => {
		for (const listener of listeners)
			queueMicrotask(() => {
				try {
					Promise.resolve(listener({ type: "product_audit", ...event })).catch(() => undefined);
				} catch {
					// Audit observers cannot interrupt a product configuration change.
				}
			});
	};
	const providerSummary = (provider: {
		id: string;
		name: string;
		models: readonly { id: string; name: string; input: readonly string[] }[];
	}): RpcProviderSummary => ({
		id: provider.id,
		name: provider.name,
		models: provider.models.map((model) => ({ id: model.id, name: model.name, input: [...model.input] })),
		configured: true,
	});
	const connect = async (signal?: AbortSignal): Promise<void> => {
		throwIfAborted(signal);
		const configurations = await options.context.require(mcpConfigServiceKey).load({
			cwd: options.cwd,
			projectTrusted,
		});
		const service = options.context.require(mcpClientServiceKey);
		if (manager !== undefined) await service.close(manager);
		connected = new Map();
		const result = await service.connect(configurations, { signal });
		throwIfAborted(signal);
		manager = result.manager;
		for (const server of result.servers)
			connected.set(server.config.id, {
				tools: server.tools.length,
				resources: server.resources.length,
				prompts: server.prompts.length,
			});
	};
	const listMcpServers = async (signal?: AbortSignal): Promise<readonly RpcMcpServerInfo[]> => {
		ensureOpen();
		throwIfAborted(signal);
		const configured = await Promise.all(
			(["user", "project", "local"] as const).map((scope) => listMcpConfig(options.cwd, scope)),
		);
		const seen = new Set<string>();
		const result = configured
			.flat()
			.filter((item) => {
				if (seen.has(item.id)) return false;
				seen.add(item.id);
				return true;
			})
			.map((item) => {
				const stats = connected.get(item.id);
				return {
					id: item.id,
					scope: item.scope,
					state: stats ? "connected" : "disconnected",
					tools: stats?.tools ?? 0,
					resources: stats?.resources ?? 0,
					prompts: stats?.prompts ?? 0,
				} satisfies RpcMcpServerInfo;
			});
		throwIfAborted(signal);
		return result;
	};
	return {
		state: () => ({ projectTrusted }),
		listProviders: () => {
			const providers = registry.snapshot().map(({ provider }) => provider);
			const selectedProvider = options.provider;
			if (selectedProvider && !providers.some((provider) => provider.id === selectedProvider.id))
				providers.push(selectedProvider);
			return providers.map(providerSummary);
		},
		login: async (input, signal) => {
			ensureOpen();
			throwIfAborted(signal);
			const selection = registry.select(input.providerId, input.modelId);
			const api = (input.api ?? API_BY_PROVIDER[input.providerId]) as Exclude<ModelApi, "faux"> | undefined;
			if (!api) throw new Error("Provider login API is unavailable.");
			await saveGlobalProviderApiKey(options.agentDir, input.providerId, api, input.apiKey, selection.model.id);
			throwIfAborted(signal);
			emitAudit({ action: "login", target: input.providerId });
			return providerSummary(selection.provider);
		},
		logout: async (providerId, signal) => {
			ensureOpen();
			throwIfAborted(signal);
			await removeGlobalProviderApiKey(options.agentDir, providerId);
			throwIfAborted(signal);
			emitAudit({ action: "logout", target: providerId });
		},
		getProjectTrust: () => projectTrusted,
		setProjectTrust: async (trusted, signal) => {
			ensureOpen();
			throwIfAborted(signal);
			await trustStore.set(options.cwd, trusted);
			throwIfAborted(signal);
			projectTrusted = trusted;
			await connect(signal).catch((cause) => {
				if (signal?.aborted) throw cause;
			});
			await options.refreshResources?.(trusted, signal);
			emitAudit({ action: "set_project_trust", projectTrusted });
			return projectTrusted;
		},
		listContextFiles: async (signal) => {
			ensureOpen();
			throwIfAborted(signal);
			const snapshot = await options.context
				.require(interactiveResourceServiceKey)
				.load({ cwd: options.cwd, agentDir: options.agentDir, projectTrusted });
			const result = snapshot.resources.contextFiles.map((file) => ({
				path: file.path,
				scope: file.scope,
				bytes: Buffer.byteLength(file.content, "utf8"),
			}));
			throwIfAborted(signal);
			return result;
		},
		listMcpServers,
		configureMcpServer: async (input, signal) => {
			ensureOpen();
			throwIfAborted(signal);
			await addMcpConfig(options.cwd, input.scope, input.serverId, input.config);
			await connect(signal);
			await options.refreshResources?.(undefined, signal);
			emitAudit({ action: "configure_mcp_server", target: input.serverId });
			return (
				(await listMcpServers()).find((server) => server.id === input.serverId) ?? {
					id: input.serverId,
					scope: input.scope,
					state: "disconnected",
					tools: 0,
					resources: 0,
					prompts: 0,
				}
			);
		},
		removeMcpServer: async (serverId, scope, signal) => {
			ensureOpen();
			throwIfAborted(signal);
			await removeMcpConfig(options.cwd, scope, serverId);
			await connect(signal);
			await options.refreshResources?.(undefined, signal);
			emitAudit({ action: "remove_mcp_server", target: serverId });
		},
		reconnectMcpServer: async (serverId, signal) => {
			ensureOpen();
			throwIfAborted(signal);
			if (!manager) await connect(signal);
			if (!manager) throw new Error("MCP manager is unavailable.");
			const server = await manager.reconnect(serverId, signal);
			connected.set(serverId, {
				tools: server.tools.length,
				resources: server.resources.length,
				prompts: server.prompts.length,
			});
			await options.refreshResources?.(undefined, signal);
			const info = (await listMcpServers()).find((item) => item.id === serverId);
			if (!info) throw new Error(`MCP server "${serverId}" was not found.`);
			emitAudit({ action: "reconnect_mcp_server", target: serverId });
			return info;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			if (manager !== undefined) await options.context.require(mcpClientServiceKey).close(manager);
			manager = undefined;
			connected.clear();
			listeners.clear();
		},
	};
}
