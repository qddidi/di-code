import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "@di-code/agent";
import { Agent as AgentImpl } from "@di-code/agent";
import type { AssistantMessage, FauxResponse, Message, Model, Provider, ThinkingLevel, Usage } from "@di-code/ai";
import {
	createAnthropicProvider,
	createDeepSeekProvider,
	createFauxProvider,
	createKimiProvider,
	createOpenAIProvider,
	createZhipuProvider,
	MODELS,
} from "@di-code/ai";
import { createServiceKey, type PluginDefinition, type RegistryOwner } from "@di-code/plugin-runtime";
import { createBashTool, createLocalBashOperations } from "./tool-bash-implementation.ts";
import type {
	NetworkCapability,
	ProcessCapability,
	RuntimeAgentTool,
	ToolApprovalCapability,
	ToolCapabilitySnapshot,
	ToolFactory,
	ToolOutputCapability,
	ToolPolicyCapability,
	WorkspaceCapability,
} from "./tool-capabilities.ts";
import { createEditTool } from "./tool-edit-implementation.ts";
import { createGlobTool } from "./tool-glob-implementation.ts";
import { createGrepTool } from "./tool-grep-implementation.ts";
import { createLoadSkillTool } from "./tool-load-skill-implementation.ts";
import { toolRead } from "./tool-read.ts";
import { createReadTool } from "./tool-read-implementation.ts";
import { createToolRegistry, toolRegistry, toolRegistryKey } from "./tool-registry.ts";
import { createWriteTool } from "./tool-write-implementation.ts";

export * from "./edit-diff.ts";
export * from "./file-mutation-queue.ts";
export * from "./file-search.ts";
export * from "./path-boundary.ts";
export * from "./tool-bash-implementation.ts";
export * from "./tool-capabilities.ts";
export * from "./tool-edit-implementation.ts";
export * from "./tool-glob-implementation.ts";
export * from "./tool-grep-implementation.ts";
export * from "./tool-load-skill-implementation.ts";
export * from "./tool-read-implementation.ts";
export * from "./tool-write-implementation.ts";

export interface ProviderSelection {
	readonly provider: Provider;
	readonly model: Model;
}

export interface ModelCatalog {
	readonly list: (providerId?: string) => readonly Model[];
	readonly find: (providerId: string, modelId: string) => Model | undefined;
}

export interface CredentialEnv {
	readonly resolve: (value: string | undefined, label: string) => string | undefined;
}

export interface RuntimeSelection {
	readonly selected: () => ProviderSelection;
	readonly reasoningLevel: () => ThinkingLevel | undefined;
}

export interface RuntimeProviderConfig {
	readonly providerId?: string;
	readonly modelId?: string;
	readonly providers: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>;
}

export interface ProviderRegistry {
	readonly register: (selection: ProviderSelection) => void;
	readonly list: () => readonly ProviderSelection[];
	readonly snapshot: () => readonly ProviderSelection[];
	readonly select: (providerId: string, modelId?: string) => ProviderSelection;
}

export { type ToolRegistry, toolRegistry, toolRegistryKey } from "./tool-registry.ts";
export { toolRead };

export interface SessionStoreFactory {
	readonly create: (options: unknown) => unknown | Promise<unknown>;
	readonly open: (filePath: string, options?: unknown) => unknown | Promise<unknown>;
}

export interface SessionStoreRegistry {
	readonly register: (name: string, factory: SessionStoreFactory) => () => void;
	readonly get: (name: string) => SessionStoreFactory | undefined;
	readonly snapshot: () => readonly { readonly name: string; readonly factory: SessionStoreFactory }[];
}

export interface PromptRegistry {
	readonly register: (name: string, get: (input?: unknown) => string | Promise<string>) => () => void;
	readonly snapshot: () => readonly {
		readonly name: string;
		readonly get: (input?: unknown) => string | Promise<string>;
	}[];
}

export interface CompactionRegistry {
	readonly register: (
		name: string,
		compact: (input: unknown, signal?: AbortSignal) => unknown | Promise<unknown>,
	) => () => void;
	readonly snapshot: () => readonly {
		readonly name: string;
		readonly compact: (input: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
	}[];
}

/** Input accepted by compaction contributions that transform persisted messages. */
export interface CompactionMessageInput {
	readonly messages: readonly Message[];
	readonly maxChars?: number;
}

export interface ResourceRegistry {
	readonly register: (name: string, resource: unknown) => () => void;
	readonly snapshot: () => readonly { readonly name: string; readonly resource: unknown }[];
}

export interface SessionMigrationRegistry {
	readonly register: (name: string, migrate: (filePath: string) => void | Promise<void>) => () => void;
	readonly migrate: (filePath: string) => Promise<void>;
	readonly snapshot: () => readonly string[];
}

export interface DiagnosticSinkRegistry {
	readonly register: (name: string, sink: (diagnostic: RuntimeDiagnostic) => void) => () => void;
	readonly emit: (diagnostic: RuntimeDiagnostic) => void;
	readonly snapshot: () => readonly string[];
}

export interface TestRuntimeService {
	readonly snapshot: () => { readonly events: number };
	readonly reset: () => void;
}

export interface PluginProfilerService {
	readonly events: () => number;
}

export interface UsageMeter {
	readonly add: (usage: Usage) => void;
	readonly snapshot: () => SessionUsageSnapshot;
}

export interface SessionUsageSnapshot {
	readonly requestCount: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly cost: Usage["cost"];
}

export interface ContextBudgetService {
	readonly resolve: (model: Model) => {
		readonly contextWindow: number;
		readonly reserveTokens: number;
		readonly triggerTokens: number;
	};
	readonly estimate: (messages: readonly Message[]) => number;
}

export const providerRegistryKey = createServiceKey<ProviderRegistry>("provider-registry");
export const workspaceCapabilityKey = createServiceKey<WorkspaceCapability>("workspace-capability");
export const processCapabilityKey = createServiceKey<ProcessCapability>("process-capability");
export const networkCapabilityKey = createServiceKey<NetworkCapability>("network-capability");
export const toolApprovalKey = createServiceKey<ToolApprovalCapability>("tool-approval");
export const toolPolicyKey = createServiceKey<ToolPolicyCapability>("tool-policy");
export const toolOutputKey = createServiceKey<ToolOutputCapability>("tool-output");
export const sessionStoreRegistryKey = createServiceKey<SessionStoreRegistry>("session-store");
export const promptRegistryKey = createServiceKey<PromptRegistry>("prompt-registry");
export const compactionRegistryKey = createServiceKey<CompactionRegistry>("compaction-registry");
export const resourceRegistryKey = createServiceKey<ResourceRegistry>("resource-registry");
export const sessionMigrationRegistryKey = createServiceKey<SessionMigrationRegistry>("session-migrations");
export const diagnosticSinkRegistryKey = createServiceKey<DiagnosticSinkRegistry>("diagnostic-sinks");
export const testRuntimeKey = createServiceKey<TestRuntimeService>("test-runtime");
export const pluginProfilerKey = createServiceKey<PluginProfilerService>("plugin-profiler");
export const usageMeterKey = createServiceKey<UsageMeter>("usage-meter");
export const contextBudgetKey = createServiceKey<ContextBudgetService>("context-budget");
export const sessionTreeKey = createServiceKey<SessionTreeService>("session-tree");
export const sessionQueryKey = createServiceKey<SessionQueryService>("session-query");
export const agentSessionKey = createServiceKey<AgentSessionFactory>("agent-session");
export const rpcMethodRegistryKey = createServiceKey<RpcMethodRegistry>("rpc-method-registry");
export const rpcEventServiceKey = createServiceKey<RpcEventService>("rpc-events");
export const modelCatalogKey = createServiceKey<ModelCatalog>("model-catalog");
export const credentialEnvKey = createServiceKey<CredentialEnv>("credential-env");
export const runtimeSelectionKey = createServiceKey<RuntimeSelection>("runtime-selection");
export const runtimeConfigKey = createServiceKey<RuntimeProviderConfig>("runtime-config");
export const sessionStoreKey = createServiceKey<MemorySessionStore>("session-store");
export const hostCommandRegistryKey = createServiceKey<HostCommandRegistry>("host-command-registry");
export const commandRegistryKey = createServiceKey<CommandRegistry>("command-registry");
export const cliParserKey = createServiceKey<CliParser>("cli-parser");
export const modeRegistryKey = createServiceKey<ModeRegistry>("mode-registry");
export const rendererRegistryKey = createServiceKey<RendererRegistry>("renderer-registry");
export const themeRegistryKey = createServiceKey<ThemeRegistry>("theme-registry");
export const keybindingRegistryKey = createServiceKey<KeybindingRegistry>("keybinding-registry");
export const interactiveContextKey = createServiceKey<InteractiveContextService>("interactive-context");
export const diagnosticsKey = createServiceKey<Diagnostics>("diagnostics");
export const runtimeKey = createServiceKey<RuntimeService>("runtime");
export const processExitKey = createServiceKey<ProcessExit>("process-exit");
export const agentLoopKey = createServiceKey<AgentLoopService>("agent-loop");
export const printRequestKey = createServiceKey<PrintRequest>("print-request");

export interface RuntimeService {
	readonly profile: string;
}

export interface ProcessExit {
	readonly setCode: (code: number) => void;
	readonly code: () => number;
}

export interface Diagnostics {
	readonly records: readonly RuntimeDiagnostic[];
	readonly report: (record: RuntimeDiagnostic) => void;
}

export interface RuntimeDiagnostic {
	readonly type: "plugin_status" | "plugin_error" | "session_dispose";
	readonly pluginName?: string;
	readonly status?: string;
	readonly message?: string;
}

export interface HostCommandRegistry {
	readonly register: (name: string, run: HostCommand["run"]) => () => void;
	readonly execute: (name: string, input: unknown, signal?: AbortSignal) => Promise<number>;
	readonly list: () => readonly string[];
}

export interface HostCommand {
	readonly run: (input: unknown, signal?: AbortSignal) => number | Promise<number>;
}

export interface CommandDefinition {
	readonly name: string;
	readonly description: string | ((locale: string) => string);
	readonly run: (input: unknown, signal?: AbortSignal) => number | Promise<number>;
}

export interface CliParser<Parsed = unknown> {
	readonly parse: (args: readonly string[]) => Parsed;
	readonly help: (locale: string) => string;
}

export interface CommandRegistry {
	readonly register: (command: CommandDefinition, owner?: RegistryOwner) => () => void;
	readonly execute: (name: string, input: unknown, signal?: AbortSignal) => Promise<number>;
	readonly list: () => readonly CommandDefinition[];
	readonly help: (locale: string) => string;
}

export interface ModeDefinition {
	readonly name: string;
	readonly run: (input: unknown, signal?: AbortSignal) => number | Promise<number>;
}

export interface ModeRegistry {
	readonly register: (mode: ModeDefinition, owner?: RegistryOwner) => () => void;
	readonly execute: (name: string, input: unknown, signal?: AbortSignal) => Promise<number>;
	readonly list: () => readonly ModeDefinition[];
}

export interface RendererDefinition {
	readonly name: string;
	readonly render: (event: unknown) => string | undefined;
}

export interface RendererRegistry {
	readonly register: (renderer: RendererDefinition, owner?: RegistryOwner) => () => void;
	readonly find: (name: string) => RendererDefinition | undefined;
	readonly list: () => readonly RendererDefinition[];
}

export interface ThemeRegistry {
	readonly register: (name: string, theme: unknown, owner?: RegistryOwner) => () => void;
	readonly get: (name: string) => unknown | undefined;
	readonly list: () => readonly { readonly name: string; readonly theme: unknown }[];
}

export interface KeybindingRegistry {
	readonly set: (bindings: unknown, owner?: RegistryOwner) => () => void;
	readonly snapshot: () => unknown;
}

export interface InteractiveContextBindings {
	readonly sessionChoices: () => readonly unknown[];
	readonly cancel: () => void;
	readonly retry: () => void | Promise<void>;
	readonly theme: () => string;
	readonly setTheme: (theme: string) => void;
	readonly keybindings: () => unknown;
}

export interface InteractiveContextService extends InteractiveContextBindings {
	/** Binds per-session interactive state and restores the previous binding when disposed. */
	readonly bind: (bindings: InteractiveContextBindings) => () => void;
}

export interface PrintRequest {
	readonly prompt: string;
	readonly stdout: (text: string) => void;
}

export interface JsonRequest {
	readonly prompt: string;
	readonly stdout: (text: string) => void;
}

export interface AgentLoopService {
	readonly prompt: (prompt: string, signal?: AbortSignal) => Promise<AssistantMessage>;
	readonly agent: Agent;
	readonly disposed: () => boolean;
}

export interface SessionTreeService {
	readonly getTree: (session: unknown) => unknown;
}

export interface SessionQueryService {
	readonly getBranch: (session: unknown, leafId?: string) => unknown;
}

export interface AgentSessionFactory {
	readonly register: (create: (options: unknown) => unknown | Promise<unknown>) => () => void;
	readonly create: (options: unknown) => unknown | Promise<unknown>;
}

/** Registry-owned RPC methods. Names must be declared in a protocol namespace before a server accepts them. */
export interface RpcMethodRegistry {
	readonly register: (namespace: string, name: string) => () => void;
	readonly has: (name: string) => boolean;
	readonly list: () => readonly { readonly namespace: string; readonly name: string }[];
}

/** Projects typed session events onto the RPC event channel without owning an Agent loop. */
export interface RpcEventService {
	readonly enabled: () => boolean;
}

export interface MemorySessionStore {
	readonly append: (record: unknown) => void;
	readonly records: () => readonly unknown[];
	readonly dispose: () => void;
	readonly disposed: () => boolean;
}

function createRegistry(): ProviderRegistry {
	const entries: Provider[] = [];
	return {
		register(selection) {
			if (entries.some((entry) => entry.id === selection.provider.id))
				throw new Error(`Duplicate provider: ${selection.provider.id}`);
			entries.push(selection.provider);
		},
		list: () =>
			entries.flatMap((provider) => {
				const model = provider.models[0];
				return model ? [{ provider, model }] : [];
			}),
		snapshot: () =>
			entries
				.map((provider) => ({ provider, model: provider.models[0] }))
				.filter((entry): entry is ProviderSelection => entry.model !== undefined),
		select(providerId, modelId) {
			const provider = entries.find((candidate) => candidate.id === providerId);
			if (!provider) throw new Error(`Unknown provider: ${providerId}`);
			const model =
				modelId === undefined ? provider.models[0] : provider.models.find((candidate) => candidate.id === modelId);
			if (!model) throw new Error(`Unknown model "${modelId ?? ""}" for provider "${providerId}"`);
			return { provider, model };
		},
	};
}

/** Creates a tool registry populated by the built-in tool entries for legacy product sessions. */
export function createBuiltinToolSnapshot(
	capabilities: ToolCapabilitySnapshot,
	extraTools: readonly RuntimeAgentTool[] = [],
): readonly RuntimeAgentTool[] {
	const registry = createToolRegistry();
	for (const [name, factory] of Object.entries(defaultToolFactories)) registry.registerFactory(name, factory);
	for (const tool of extraTools) registry.register(tool);
	return registry.snapshot(capabilities);
}

const defaultToolFactories: Readonly<Record<string, ToolFactory>> = {
	read: (capabilities) => createReadTool(capabilities.workspace.allowedRoot),
	write: (capabilities) => createWriteTool(capabilities.workspace.allowedRoot),
	edit: (capabilities) => createEditTool(capabilities.workspace.allowedRoot),
	bash: (capabilities) =>
		createBashTool(capabilities.workspace.allowedRoot, { operations: capabilities.process.bashOperations }),
	glob: (capabilities) => createGlobTool(capabilities.workspace.allowedRoot),
	grep: (capabilities) => createGrepTool(capabilities.workspace.allowedRoot),
	load_skill: (capabilities) => {
		const catalog = capabilities.skills;
		return catalog?.listForModel().length === 0 || catalog === undefined ? undefined : createLoadSkillTool(catalog);
	},
};

function createNamedRegistry<T>(
	kind: "prompt" | "compaction" | "resource",
): PromptRegistry | CompactionRegistry | ResourceRegistry {
	const entries = new Map<string, T>();
	return {
		register(name: string, value: T) {
			if (entries.has(name)) throw new Error(`Duplicate ${kind} registration: ${name}`);
			entries.set(name, value);
			return () => {
				if (entries.get(name) === value) entries.delete(name);
			};
		},
		snapshot: () =>
			[...entries.entries()].map(([name, value]) => ({
				name,
				...(kind === "prompt" ? { get: value } : kind === "compaction" ? { compact: value } : { resource: value }),
			})) as never,
	} as PromptRegistry | CompactionRegistry | ResourceRegistry;
}

function createUsageMeter(): UsageMeter {
	let snapshot: SessionUsageSnapshot = {
		requestCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		add(usage) {
			snapshot = {
				requestCount: snapshot.requestCount + 1,
				inputTokens: snapshot.inputTokens + usage.input,
				outputTokens: snapshot.outputTokens + usage.output,
				cacheReadTokens: snapshot.cacheReadTokens + usage.cacheRead,
				cacheWriteTokens: snapshot.cacheWriteTokens + usage.cacheWrite,
				totalTokens: snapshot.totalTokens + usage.totalTokens,
				cost: {
					input: snapshot.cost.input + usage.cost.input,
					output: snapshot.cost.output + usage.cost.output,
					cacheRead: snapshot.cost.cacheRead + usage.cost.cacheRead,
					cacheWrite: snapshot.cost.cacheWrite + usage.cost.cacheWrite,
					total: snapshot.cost.total + usage.cost.total,
				},
			};
		},
		snapshot: () => ({ ...snapshot, cost: { ...snapshot.cost } }),
	};
}

export function createCommandRegistry(): CommandRegistry {
	const commands = new Map<string, CommandDefinition>();
	return {
		register(command) {
			if (!/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/.test(command.name))
				throw new Error(`Invalid command name: ${command.name}`);
			if (commands.has(command.name)) throw new Error(`Duplicate command: ${command.name}`);
			commands.set(command.name, command);
			return () => {
				if (commands.get(command.name) === command) commands.delete(command.name);
			};
		},
		async execute(name, input, signal) {
			const command = commands.get(name);
			if (!command) throw new Error(`Unknown command: ${name}`);
			return await command.run(input, signal);
		},
		list: () => Object.freeze([...commands.values()].sort((left, right) => left.name.localeCompare(right.name))),
		help: (locale) =>
			[...commands.values()]
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((command) => {
					const description =
						typeof command.description === "function" ? command.description(locale) : command.description;
					return `/${command.name}\t${description}`;
				})
				.join("\n"),
	};
}

export function createModeRegistry(): ModeRegistry {
	const modes = new Map<string, ModeDefinition>();
	return {
		register(mode) {
			if (!/^[a-z][a-z0-9-]*$/.test(mode.name)) throw new Error(`Invalid mode name: ${mode.name}`);
			if (modes.has(mode.name)) throw new Error(`Duplicate mode: ${mode.name}`);
			modes.set(mode.name, mode);
			return () => {
				if (modes.get(mode.name) === mode) modes.delete(mode.name);
			};
		},
		async execute(name, input, signal) {
			const mode = modes.get(name);
			if (!mode) throw new Error(`Unknown mode: ${name}`);
			return await mode.run(input, signal);
		},
		list: () => Object.freeze([...modes.values()].sort((left, right) => left.name.localeCompare(right.name))),
	};
}

export function createRendererRegistry(): RendererRegistry {
	const renderers = new Map<string, RendererDefinition>();
	return {
		register(renderer) {
			if (renderers.has(renderer.name)) throw new Error(`Duplicate renderer: ${renderer.name}`);
			renderers.set(renderer.name, renderer);
			return () => {
				if (renderers.get(renderer.name) === renderer) renderers.delete(renderer.name);
			};
		},
		find: (name) => renderers.get(name),
		list: () => Object.freeze([...renderers.values()].sort((left, right) => left.name.localeCompare(right.name))),
	};
}

function createThemeRegistry(): ThemeRegistry {
	const themes = new Map<string, unknown>();
	return {
		register(name, theme) {
			if (themes.has(name)) throw new Error(`Duplicate theme: ${name}`);
			themes.set(name, theme);
			return () => {
				if (themes.get(name) === theme) themes.delete(name);
			};
		},
		get: (name) => themes.get(name),
		list: () => Object.freeze([...themes].map(([name, theme]) => ({ name, theme }))),
	};
}

function createKeybindingRegistry(): KeybindingRegistry {
	let current: unknown;
	return {
		set(bindings) {
			const previous = current;
			current = bindings;
			return () => {
				if (current === bindings) current = previous;
			};
		},
		snapshot: () => current,
	};
}

function commandHost(name: string, input: unknown): Promise<number> {
	if (typeof input !== "object" || input === null || !("host" in input))
		return Promise.reject(new Error(`Command ${name} requires an interactive command host`));
	const host = input.host;
	if (typeof host !== "object" || host === null || !("runCommand" in host) || typeof host.runCommand !== "function")
		return Promise.reject(new Error(`Command ${name} received an invalid interactive command host`));
	const args = "args" in input && typeof input.args === "string" ? input.args : "";
	return Promise.resolve(host.runCommand(name, args));
}

function commandDefinition(name: string, description: string): CommandDefinition {
	return { name, description, run: (input) => commandHost(name, input) };
}

export function createBuiltinCommandRegistry(): CommandRegistry {
	const registry = createCommandRegistry();
	for (const [name, description] of [
		["help", "Show available commands"],
		["clear", "Clear visible messages"],
		["model", "Choose a model"],
		["session", "Choose a session"],
		["tree", "Browse session history"],
		["theme", "Choose a theme"],
		["settings", "Open settings"],
		["login", "Configure a Provider"],
		["logout", "Remove Provider credentials"],
		["compact", "Compact context"],
		["usage", "Show usage"],
		["retry", "Retry the last prompt"],
		["steer", "Steer the running Agent"],
	] as const)
		registry.register(commandDefinition(name, description));
	return registry;
}

export const providerRegistry: PluginDefinition = {
	apiVersion: 1,
	name: "provider-registry",
	version: "0.1.7",
	apply(context) {
		context.set(providerRegistryKey, createRegistry());
	},
};

function registerToolFactory(
	context: Parameters<PluginDefinition["apply"]>[0],
	fiber: Parameters<PluginDefinition["apply"]>[2],
	name: string,
	factory: ToolFactory,
): void {
	const dispose = context.require(toolRegistryKey).registerFactory(name, factory);
	fiber.addDisposer(dispose);
}

export interface WorkspaceConfig {
	readonly allowedRoot?: string;
}

export const workspace: PluginDefinition<WorkspaceConfig> = {
	apiVersion: 1,
	name: "workspace",
	version: "0.1.7",
	apply(context, config) {
		context.set(workspaceCapabilityKey, { allowedRoot: config?.allowedRoot ?? process.cwd() });
	},
};

export const processCapability: PluginDefinition = {
	apiVersion: 1,
	name: "process",
	version: "0.1.7",
	apply(context) {
		context.set(processCapabilityKey, { bashOperations: createLocalBashOperations() });
	},
};

export const networkCapability: PluginDefinition = {
	apiVersion: 1,
	name: "network",
	version: "0.1.7",
	apply(context) {
		context.set(networkCapabilityKey, { available: false });
	},
};

export const toolApproval: PluginDefinition = {
	apiVersion: 1,
	name: "tool-approval",
	version: "0.1.7",
	apply(context) {
		context.set(toolApprovalKey, { request: () => undefined });
	},
};

export const toolPolicy: PluginDefinition = {
	apiVersion: 1,
	name: "tool-policy",
	version: "0.1.7",
	apply(context) {
		context.set(toolPolicyKey, { authorize: () => undefined });
	},
};

export const toolOutput: PluginDefinition = {
	apiVersion: 1,
	name: "tool-output",
	version: "0.1.7",
	apply(context) {
		context.set(toolOutputKey, { present: (result) => result });
	},
};

export const toolWrite: PluginDefinition = {
	apiVersion: 1,
	name: "tool-write",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerToolFactory(context, fiber, "write", defaultToolFactories.write);
	},
};

export const toolEdit: PluginDefinition = {
	apiVersion: 1,
	name: "tool-edit",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerToolFactory(context, fiber, "edit", defaultToolFactories.edit);
	},
};

export const toolBash: PluginDefinition = {
	apiVersion: 1,
	name: "tool-bash",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerToolFactory(context, fiber, "bash", defaultToolFactories.bash);
	},
};

export const toolGlob: PluginDefinition = {
	apiVersion: 1,
	name: "tool-glob",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerToolFactory(context, fiber, "glob", defaultToolFactories.glob);
	},
};

export const toolGrep: PluginDefinition = {
	apiVersion: 1,
	name: "tool-grep",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerToolFactory(context, fiber, "grep", defaultToolFactories.grep);
	},
};

export const toolLoadSkill: PluginDefinition = {
	apiVersion: 1,
	name: "tool-load-skill",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerToolFactory(context, fiber, "load_skill", defaultToolFactories.load_skill);
	},
};

export const sessionStoreJsonl: PluginDefinition = {
	apiVersion: 1,
	name: "session-store-jsonl",
	version: "0.1.7",
	apply(context) {
		if (context.get(sessionStoreRegistryKey)) return;
		const factories = new Map<string, SessionStoreFactory>();
		context.set(sessionStoreRegistryKey, {
			register(name, factory) {
				if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid session store name: ${name}`);
				if (factories.has(name)) throw new Error(`Duplicate session store: ${name}`);
				factories.set(name, factory);
				return () => {
					if (factories.get(name) === factory) factories.delete(name);
				};
			},
			get: (name) => factories.get(name),
			snapshot: () => Object.freeze([...factories].map(([name, factory]) => ({ name, factory }))),
		});
	},
};

export const sessionTree: PluginDefinition = {
	apiVersion: 1,
	name: "session-tree",
	version: "0.1.7",
	apply(context) {
		context.set(sessionTreeKey, {
			getTree: (session) => {
				if (typeof session !== "object" || session === null || !("getTree" in session))
					throw new TypeError("Session does not provide getTree");
				const getTree = session.getTree;
				if (typeof getTree !== "function") throw new TypeError("Session getTree is not callable");
				return getTree.call(session);
			},
		});
	},
};

export const sessionQuery: PluginDefinition = {
	apiVersion: 1,
	name: "session-query",
	version: "0.1.7",
	apply(context) {
		context.set(sessionQueryKey, {
			getBranch: (session, leafId) => {
				if (typeof session !== "object" || session === null || !("getBranch" in session))
					throw new TypeError("Session does not provide getBranch");
				const getBranch = session.getBranch;
				if (typeof getBranch !== "function") throw new TypeError("Session getBranch is not callable");
				return getBranch.call(session, leafId);
			},
		});
	},
};

export const usageMeter: PluginDefinition = {
	apiVersion: 1,
	name: "usage-meter",
	version: "0.1.7",
	apply(context) {
		context.set(usageMeterKey, createUsageMeter());
	},
};

export const contextBudget: PluginDefinition = {
	apiVersion: 1,
	name: "context-budget",
	version: "0.1.7",
	apply(context) {
		context.set(contextBudgetKey, {
			resolve: (model) => {
				if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)
					throw new RangeError("model.contextWindow must be a positive integer");
				if (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 0)
					throw new RangeError("model.maxOutputTokens must be a non-negative integer");
				const reserveTokens = Math.max(model.maxOutputTokens, Math.ceil(model.contextWindow * 0.1));
				if (reserveTokens >= model.contextWindow) throw new RangeError("Model context budget leaves no room for input");
				return {
					contextWindow: model.contextWindow,
					reserveTokens,
					triggerTokens: model.contextWindow - reserveTokens,
				};
			},
			estimate: (messages) =>
				messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message).length / 4), 0),
		});
	},
};

export const compactionBasic: PluginDefinition = {
	apiVersion: 1,
	name: "compaction-basic",
	version: "0.1.7",
	apply(context) {
		context.set(compactionRegistryKey, createNamedRegistry("compaction") as CompactionRegistry);
	},
};

/** Adds tool-result compaction as an independently removable contribution. */
export const compactionToolResult: PluginDefinition = {
	apiVersion: 1,
	name: "compaction-tool-result",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const registry = context.require(compactionRegistryKey);
		fiber.addDisposer(
			registry.register("tool-result", (input) => {
				if (typeof input !== "object" || input === null)
					throw new TypeError("tool-result compaction input must be an object");
				const maxChars =
					"maxChars" in input && typeof input.maxChars === "number" ? Math.max(0, input.maxChars) : 4_000;
				if ("text" in input && typeof input.text === "string") {
					return { ...input, text: input.text.length > maxChars ? `${input.text.slice(0, maxChars)}...` : input.text };
				}
				if (!Array.isArray((input as CompactionMessageInput).messages))
					throw new TypeError("tool-result compaction input must contain text or messages");
				const messages = (input as CompactionMessageInput).messages.map((message) => {
					if (message.role !== "tool_result") return message;
					return {
						...message,
						content: message.content.map((content) =>
							content.type === "text" && content.text.length > maxChars
								? { ...content, text: `${content.text.slice(0, maxChars)}...` }
								: content,
						),
					};
				});
				return { ...input, messages };
			}),
		);
	},
};

export const sessionMigrations: PluginDefinition = {
	apiVersion: 1,
	name: "session-migrations",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const migrations = new Map<string, (filePath: string) => void | Promise<void>>();
		const registry: SessionMigrationRegistry = {
			register(name, migrate) {
				if (migrations.has(name)) throw new Error(`Duplicate session migration: ${name}`);
				migrations.set(name, migrate);
				return () => {
					if (migrations.get(name) === migrate) migrations.delete(name);
				};
			},
			migrate: async (filePath) => {
				for (const migrate of migrations.values()) await migrate(filePath);
			},
			snapshot: () => Object.freeze([...migrations.keys()]),
		};
		context.set(sessionMigrationRegistryKey, registry);
		fiber.addDisposer(
			registry.register("session-v2-plugin-records", async (filePath) => {
				await migratePluginRecordSchema(filePath);
			}),
		);
	},
};

/**
 * Upgrades the only legacy plugin-record schema owned by the built-ins. The rewrite is
 * atomic and preserves unknown records and their append order; session v1 headers are
 * deliberately left for the Session decoder to reject because that format is incompatible.
 */
async function migratePluginRecordSchema(filePath: string): Promise<void> {
	let source: string;
	try {
		source = await readFile(filePath, "utf8");
	} catch (cause) {
		if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return;
		throw cause;
	}
	const lines = source.split("\n");
	let changed = false;
	const migrated = lines.map((line) => {
		if (line.trim() === "") return line;
		let record: unknown;
		try {
			record = JSON.parse(line) as unknown;
		} catch {
			return line;
		}
		if (
			typeof record !== "object" ||
			record === null ||
			(record as { readonly type?: unknown }).type !== "plugin" ||
			(record as { readonly pluginId?: unknown }).pluginId !== "@di-code/session" ||
			(record as { readonly schemaVersion?: unknown }).schemaVersion !== 0
		)
			return line;
		changed = true;
		return JSON.stringify({ ...record, schemaVersion: 1 });
	});
	if (!changed) return;
	const temporary = `${filePath}.migration-${process.pid}-${Date.now()}.tmp`;
	try {
		await writeFile(temporary, migrated.join("\n"), "utf8");
		await rename(temporary, filePath);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export const systemPrompt: PluginDefinition = {
	apiVersion: 1,
	name: "system-prompt",
	version: "0.1.7",
	apply(context) {
		context.set(promptRegistryKey, createNamedRegistry("prompt") as PromptRegistry);
	},
};

export const resourceLoader: PluginDefinition = {
	apiVersion: 1,
	name: "resource-loader",
	version: "0.1.7",
	apply(context) {
		context.set(resourceRegistryKey, createNamedRegistry("resource") as ResourceRegistry);
	},
};

export const skills: PluginDefinition = {
	apiVersion: 1,
	name: "skills",
	version: "0.1.7",
	apply(context) {
		if (!context.get(resourceRegistryKey))
			context.set(resourceRegistryKey, createNamedRegistry("resource") as ResourceRegistry);
	},
};

export const agentSession: PluginDefinition = {
	apiVersion: 1,
	name: "agent-session",
	version: "0.1.7",
	apply(context) {
		context.require(providerRegistryKey);
		context.require(toolRegistryKey);
		context.require(promptRegistryKey);
		context.require(compactionRegistryKey);
		let create: ((options: unknown) => unknown | Promise<unknown>) | undefined;
		context.set(agentSessionKey, {
			register(factory) {
				if (create !== undefined) throw new Error("AgentSession factory is already registered");
				create = factory;
				return () => {
					if (create === factory) create = undefined;
				};
			},
			create(options) {
				if (create === undefined) throw new Error("AgentSession factory is not registered");
				return create(options);
			},
		});
	},
};

function createRpcMethodRegistry(): RpcMethodRegistry {
	const methods = new Map<string, { readonly namespace: string; readonly name: string }>();
	return {
		register(namespace, name) {
			if (!/^[a-z0-9][a-z0-9._-]*$/.test(namespace)) throw new Error(`Invalid RPC method namespace: ${namespace}`);
			if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid RPC method name: ${name}`);
			if (methods.has(name)) throw new Error(`Duplicate RPC method: ${name}`);
			const entry = Object.freeze({ namespace, name });
			methods.set(name, entry);
			return () => {
				if (methods.get(name) === entry) methods.delete(name);
			};
		},
		has: (name) => methods.has(name),
		list: () => Object.freeze([...methods.values()].sort((left, right) => left.name.localeCompare(right.name))),
	};
}

/** Registers the fixed RPC v1 method inventory. Server behavior remains versioned in @di-code/coding-agent/rpc. */
export const rpcProtocolV1: PluginDefinition = {
	apiVersion: 1,
	name: "rpc-protocol-v1",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const registry = createRpcMethodRegistry();
		context.set(rpcMethodRegistryKey, registry);
		// The dispatcher validates every method schema. This inventory is intentionally explicit so a
		// composition plugin cannot turn commandRegistry entries into remotely executable methods.
		for (const name of [
			"prompt",
			"cancel",
			"get_state",
			"get_capabilities",
			"resume_events",
			"list_sessions",
			"new_session",
			"open_session",
			"get_transcript",
			"get_tree",
			"navigate_tree",
			"steer",
			"retry",
			"get_operation",
			"get_models",
			"set_model",
			"get_runtime",
			"set_runtime",
			"set_thinking_level",
			"compact",
			"set_compaction_enabled",
			"get_usage",
			"list_skills",
			"get_resources",
			"get_product_state",
			"list_providers",
			"login",
			"logout",
			"get_project_trust",
			"set_project_trust",
			"list_context_files",
			"list_mcp_servers",
			"configure_mcp_server",
			"remove_mcp_server",
			"reconnect_mcp_server",
			"create_attachment",
			"approve_tool",
		] as const)
			fiber.addDisposer(registry.register("di-code.rpc-v1", name));
	},
};

/** Declares that an RPC server consumes SessionFactory and RpcMethodRegistry services. */
export const rpcServer: PluginDefinition = {
	apiVersion: 1,
	name: "rpc-server",
	version: "0.1.7",
	apply(context) {
		context.require(agentSessionKey);
		context.require(rpcMethodRegistryKey);
	},
};

/** Enables the typed session-event projection used by the RPC server. */
export const rpcEvents: PluginDefinition = {
	apiVersion: 1,
	name: "rpc-events",
	version: "0.1.7",
	apply(context) {
		context.set(rpcEventServiceKey, { enabled: () => true });
	},
};

export const bootstrap: PluginDefinition = {
	apiVersion: 1,
	name: "Bootstrap",
	version: "0.1.7",
	apply(context) {
		const commands = new Map<string, HostCommand["run"]>();
		const registry: HostCommandRegistry = {
			register(name, run) {
				if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid host command: ${name}`);
				if (commands.has(name)) throw new Error(`Duplicate host command: ${name}`);
				commands.set(name, run);
				return () => {
					if (commands.get(name) === run) commands.delete(name);
				};
			},
			async execute(name, input, signal) {
				const run = commands.get(name);
				if (!run) throw new Error(`Unknown host command: ${name}`);
				return await run(input, signal);
			},
			list: () => Object.freeze([...commands.keys()].sort()),
		};
		context.set(hostCommandRegistryKey, registry);
	},
};

export const cliParser: PluginDefinition = {
	apiVersion: 1,
	name: "cli-parser",
	version: "0.1.7",
	apply(context) {
		const commands = context.require(commandRegistryKey);
		context.set(cliParserKey, {
			parse: (args) => [...args],
			help: (locale) => commands.help(locale),
		});
	},
};

export const commandCore: PluginDefinition = {
	apiVersion: 1,
	name: "command-core",
	version: "0.1.7",
	apply(context) {
		context.set(commandRegistryKey, createCommandRegistry());
		context.set(modeRegistryKey, createModeRegistry());
		context.set(rendererRegistryKey, createRendererRegistry());
		context.set(themeRegistryKey, createThemeRegistry());
		context.set(keybindingRegistryKey, createKeybindingRegistry());
	},
};

function registerCommands(
	context: Parameters<PluginDefinition["apply"]>[0],
	names: readonly [string, string][],
	fiber: Parameters<PluginDefinition["apply"]>[2],
): void {
	const registry = context.require(commandRegistryKey);
	for (const [name, description] of names) fiber.addDisposer(registry.register(commandDefinition(name, description)));
}

export const commandSession: PluginDefinition = {
	apiVersion: 1,
	name: "command-session",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerCommands(
			context,
			[
				["session", "Choose a session"],
				["tree", "Browse session history"],
			],
			fiber,
		);
	},
};

export const commandModel: PluginDefinition = {
	apiVersion: 1,
	name: "command-model",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerCommands(
			context,
			[
				["model", "Choose a model"],
				["login", "Configure a Provider"],
				["logout", "Remove Provider credentials"],
			],
			fiber,
		);
	},
};

export const commandSettings: PluginDefinition = {
	apiVersion: 1,
	name: "command-settings",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerCommands(
			context,
			[
				["settings", "Open settings"],
				["theme", "Choose a theme"],
			],
			fiber,
		);
	},
};

export const commandCompact: PluginDefinition = {
	apiVersion: 1,
	name: "command-compact",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerCommands(
			context,
			[
				["compact", "Compact context"],
				["usage", "Show usage"],
				["retry", "Retry the last prompt"],
			],
			fiber,
		);
	},
};

export const commandInteractiveCore: PluginDefinition = {
	apiVersion: 1,
	name: "command-interactive-core",
	version: "0.1.7",
	apply(context, _config, fiber) {
		registerCommands(
			context,
			[
				["help", "Show available commands"],
				["clear", "Clear visible messages"],
				["steer", "Steer the running Agent"],
			],
			fiber,
		);
	},
};

export const modeJson: PluginDefinition = {
	apiVersion: 1,
	name: "mode-json",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const run = async (input: unknown, signal?: AbortSignal): Promise<number> => {
			if (typeof input !== "object" || input === null) throw new Error("JSON request is invalid");
			const request = input as JsonRequest;
			if (typeof request.prompt !== "string" || typeof request.stdout !== "function")
				throw new Error("JSON request is invalid");
			const renderer = context.require(rendererRegistryKey).find("json");
			if (!renderer) throw new Error("JSON renderer is unavailable");
			const loop = context.require(agentLoopKey);
			const unsubscribe = loop.agent.subscribe((event) => {
				const rendered = renderer.render(event);
				if (rendered !== undefined) request.stdout(`${rendered}\n`);
			});
			try {
				const response = await loop.prompt(request.prompt, signal);
				return response.stopReason === "error" || response.stopReason === "aborted" ? 1 : 0;
			} finally {
				unsubscribe();
			}
		};
		fiber.addDisposer(context.require(hostCommandRegistryKey).register("json", run));
		fiber.addDisposer(context.require(modeRegistryKey).register({ name: "json", run }));
	},
};

export const modeInteractive: PluginDefinition = {
	apiVersion: 1,
	name: "mode-interactive",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const dispose = context.require(modeRegistryKey).register({
			name: "interactive",
			run: (input) => runModeInput("interactive", input),
		});
		fiber.addDisposer(dispose);
	},
};

export const modeRpc: PluginDefinition = {
	apiVersion: 1,
	name: "mode-rpc",
	version: "0.1.7",
	apply(context, _config, fiber) {
		fiber.addDisposer(
			context.require(modeRegistryKey).register({
				name: "rpc",
				run: (input) => runModeInput("rpc", input),
			}),
		);
	},
};

export const pluginProfiler: PluginDefinition = {
	apiVersion: 1,
	name: "plugin-profiler",
	version: "0.1.7",
	apply(context, _config, fiber) {
		let events = 0;
		const unsubscribe = context.events.subscribe(() => {
			events += 1;
		});
		fiber.addDisposer(unsubscribe);
		context.set(pluginProfilerKey, { events: () => events });
	},
};

export const pluginInvariants: PluginDefinition = {
	apiVersion: 1,
	name: "plugin-invariants",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const unsubscribe = context.events.subscribe((event) => {
			if (typeof event !== "object" || event === null || !("type" in event))
				throw new Error("Runtime event invariant violated: missing type");
		});
		fiber.addDisposer(unsubscribe);
	},
};

export const pluginTestRuntime: PluginDefinition = {
	apiVersion: 1,
	name: "plugin-test-runtime",
	version: "0.1.7",
	apply(context, _config, fiber) {
		let events = 0;
		const unsubscribe = context.events.subscribe(() => {
			events += 1;
		});
		fiber.addDisposer(unsubscribe);
		context.set(testRuntimeKey, {
			snapshot: () => ({ events }),
			reset: () => {
				events = 0;
			},
		});
	},
};

function runModeInput(name: string, input: unknown): Promise<number> {
	if (typeof input !== "object" || input === null || !("run" in input) || typeof input.run !== "function")
		return Promise.reject(new Error(`Mode ${name} requires a mode runner`));
	return Promise.resolve(input.run());
}

export const tuiRenderer: PluginDefinition = {
	apiVersion: 1,
	name: "tui-renderer",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const dispose = context.require(rendererRegistryKey).register({ name: "interactive", render: () => undefined });
		fiber.addDisposer(dispose);
	},
};

export const theme: PluginDefinition = {
	apiVersion: 1,
	name: "theme",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const registry = context.require(themeRegistryKey);
		fiber.addDisposer(registry.register("dark", { name: "dark" }));
		fiber.addDisposer(registry.register("light", { name: "light" }));
	},
};

export const outputJson: PluginDefinition = {
	apiVersion: 1,
	name: "output-json",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const dispose = context.require(rendererRegistryKey).register({
			name: "json",
			render: (event) => JSON.stringify({ version: 2, event }),
		});
		fiber.addDisposer(dispose);
	},
};

export const interactiveContext: PluginDefinition = {
	apiVersion: 1,
	name: "interactive-context",
	version: "0.1.7",
	apply(context) {
		let selectedTheme = "dark";
		let bindings: InteractiveContextBindings = {
			sessionChoices: () => [],
			cancel: () => undefined,
			retry: () => undefined,
			theme: () => selectedTheme,
			setTheme: (value) => {
				selectedTheme = value;
			},
			keybindings: () => context.get(keybindingRegistryKey)?.snapshot(),
		};
		context.set(interactiveContextKey, {
			sessionChoices: () => bindings.sessionChoices(),
			cancel: () => bindings.cancel(),
			retry: () => bindings.retry(),
			theme: () => bindings.theme(),
			setTheme: (theme) => bindings.setTheme(theme),
			keybindings: () => bindings.keybindings(),
			bind: (next) => {
				const previous = bindings;
				bindings = next;
				return () => {
					if (bindings === next) bindings = previous;
				};
			},
		});
	},
};

export const runtime: PluginDefinition = {
	apiVersion: 1,
	name: "runtime",
	version: "0.1.7",
	apply(context) {
		context.set(runtimeKey, { profile: "minimal-faux" });
	},
};

export const diagnostics: PluginDefinition = {
	apiVersion: 1,
	name: "diagnostics",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const records: RuntimeDiagnostic[] = [];
		const sinks = new Map<string, (diagnostic: RuntimeDiagnostic) => void>();
		const sinkRegistry: DiagnosticSinkRegistry = {
			register(name, sink) {
				if (sinks.has(name)) throw new Error(`Duplicate diagnostic sink: ${name}`);
				sinks.set(name, sink);
				return () => {
					if (sinks.get(name) === sink) sinks.delete(name);
				};
			},
			emit: (diagnostic) => {
				for (const sink of sinks.values()) sink(diagnostic);
			},
			snapshot: () => Object.freeze([...sinks.keys()]),
		};
		context.set(diagnosticSinkRegistryKey, sinkRegistry);
		const report = (record: RuntimeDiagnostic): void => {
			const snapshot = Object.freeze({ ...record });
			records.push(snapshot);
			sinkRegistry.emit(snapshot);
		};
		context.set(diagnosticsKey, { records, report });
		const unsubscribe = context.events.subscribe((event) => {
			if (event.type === "plugin_status")
				report({ type: "plugin_status", pluginName: event.pluginName, status: event.status });
			if (event.type === "plugin_error")
				report({ type: "plugin_error", pluginName: event.pluginName, message: event.error.message });
		});
		fiber.addDisposer(unsubscribe);
	},
};

export const processExit: PluginDefinition = {
	apiVersion: 1,
	name: "process-exit",
	version: "0.1.7",
	apply(context) {
		let exitCode = 0;
		context.set(processExitKey, {
			setCode: (code) => {
				exitCode = code;
			},
			code: () => exitCode,
		});
	},
};

export interface FauxProviderConfig {
	readonly responses?: readonly FauxResponse[];
	readonly chunkSize?: number;
}

export const providerFaux: PluginDefinition<FauxProviderConfig> = {
	apiVersion: 1,
	name: "provider-faux",
	version: "0.1.7",
	apply(context, config) {
		const registry = context.require(providerRegistryKey);
		const handle = createFauxProvider({
			responses: config?.responses ?? [{ type: "success", content: [{ type: "text", text: "Faux response" }] }],
			chunkSize: config?.chunkSize,
		});
		registry.register({ provider: handle.provider, model: handle.model });
	},
};

function createProviderEntry(
	name: string,
	create: (
		env: Readonly<Record<string, string | undefined>>,
		config: Readonly<Record<string, string | undefined>>,
	) => Provider,
): PluginDefinition {
	return {
		apiVersion: 1,
		name,
		version: "0.1.7",
		apply(context) {
			const config = context.require(runtimeConfigKey);
			const providerId = name.slice("provider-".length);
			const providerConfig = config.providers[providerId] ?? {};
			const credential = context.require(credentialEnvKey);
			const provider = create(process.env, {
				...providerConfig,
				apiKey: credential.resolve(providerConfig.apiKey, `${providerId}.apiKey`),
			});
			const model = provider.models[0];
			if (!model) throw new Error(`${name} provider requires at least one model`);
			context.require(providerRegistryKey).register({ provider, model });
		},
	};
}

export const modelCatalog: PluginDefinition = {
	apiVersion: 1,
	name: "model-catalog",
	version: "0.1.7",
	apply(context) {
		const catalog: ModelCatalog = {
			list: (providerId) =>
				providerId === undefined ? MODELS : MODELS.filter((model) => model.provider === providerId),
			find: (providerId, modelId) => MODELS.find((model) => model.provider === providerId && model.id === modelId),
		};
		context.set(modelCatalogKey, catalog);
	},
};

export const credentialEnv: PluginDefinition = {
	apiVersion: 1,
	name: "credential-env",
	version: "0.1.7",
	apply(context) {
		context.set(credentialEnvKey, {
			resolve(value, label) {
				if (value === undefined) return undefined;
				const trimmed = value.trim();
				const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
				if (match) {
					const variable = match[1] ?? match[2];
					const resolved = process.env[variable]?.trim();
					if (!resolved) throw new Error(`${label} environment variable "${variable}" is not set`);
					return resolved;
				}
				if (trimmed.startsWith("!")) throw new Error(`${label} command-based credentials are not supported`);
				return value;
			},
		});
	},
};

export const providerOpenai = createProviderEntry("provider-openai", (env, config) =>
	createOpenAIProvider({ env, apiKey: config.apiKey, baseUrl: config.baseUrl }),
);
export const providerAnthropic = createProviderEntry("provider-anthropic", (env, config) =>
	createAnthropicProvider({ env, apiKey: config.apiKey, baseUrl: config.baseUrl }),
);
export const providerDeepseek = createProviderEntry("provider-deepseek", (env, config) =>
	createDeepSeekProvider({ env, apiKey: config.apiKey, baseUrl: config.baseUrl }),
);
export const providerKimi = createProviderEntry("provider-kimi", (env, config) =>
	createKimiProvider({ env, apiKey: config.apiKey, baseUrl: config.baseUrl }),
);
export const providerZhipu = createProviderEntry("provider-zhipu", (env, config) =>
	createZhipuProvider({ env, apiKey: config.apiKey, baseUrl: config.baseUrl }),
);

export const runtimeSelection: PluginDefinition = {
	apiVersion: 1,
	name: "runtime-selection",
	version: "0.1.7",
	async apply(context) {
		const registry = context.require(providerRegistryKey);
		const readSettings = async (path: string): Promise<Readonly<Record<string, unknown>> | undefined> => {
			try {
				const text = await readFile(path, "utf8");
				if (!text.trim()) return undefined;
				const parsed: unknown = JSON.parse(text);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
					throw new Error(`${path}: root value must be an object`);
				return parsed as Readonly<Record<string, unknown>>;
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
				throw cause;
			}
		};
		const global = await readSettings(join(homedir(), ".di-code", "settings.json"));
		const project = await readSettings(join(process.cwd(), ".di-code", "settings.json"));
		const globalProviders = global?.providers;
		const projectProviders = project?.providers;
		const providers: Record<string, Record<string, string | undefined>> = {};
		for (const source of [globalProviders, projectProviders]) {
			if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
			for (const [id, value] of Object.entries(source)) {
				if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
				const entry = value as Record<string, unknown>;
				const target = providers[id] ?? {};
				for (const key of ["apiKey", "baseUrl"] as const) if (typeof entry[key] === "string") target[key] = entry[key];
				providers[id] = target;
			}
		}
		const providerId =
			process.env.DI_CODE_PROVIDER?.trim() ||
			(typeof project?.defaultProvider === "string" ? project.defaultProvider : undefined) ||
			(typeof global?.defaultProvider === "string" ? global.defaultProvider : undefined);
		const configuredDefaultProvider =
			typeof project?.defaultProvider === "string"
				? project.defaultProvider
				: typeof global?.defaultProvider === "string"
					? global.defaultProvider
					: undefined;
		const modelId =
			process.env.DI_CODE_MODEL?.trim() ||
			(configuredDefaultProvider === providerId && typeof project?.defaultModel === "string"
				? project.defaultModel
				: undefined) ||
			(configuredDefaultProvider === providerId && typeof global?.defaultModel === "string"
				? global.defaultModel
				: undefined);
		context.set(runtimeConfigKey, { providerId, modelId, providers });
		context.set(runtimeSelectionKey, {
			selected: () => {
				const selectedProviderId = process.env.DI_CODE_PROVIDER?.trim() || providerId;
				if (!selectedProviderId)
					throw new Error("Provider is not configured. Set DI_CODE_PROVIDER=faux for the minimal profile.");
				return registry.select(
					selectedProviderId,
					selectedProviderId === "faux" ? undefined : process.env.DI_CODE_MODEL?.trim() || modelId,
				);
			},
			reasoningLevel: () => undefined,
		});
	},
};

export const providerOnboarding: PluginDefinition = {
	apiVersion: 1,
	name: "provider-onboarding",
	version: "0.1.7",
	apply(context) {
		context.require(providerRegistryKey);
	},
};

export const sessionMemory: PluginDefinition = {
	apiVersion: 1,
	name: "session-memory",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const records: unknown[] = [];
		let closed = false;
		context.set(sessionStoreKey, {
			append: (record) => {
				if (closed) throw new Error("Session memory is disposed");
				records.push(structuredClone(record));
			},
			records: () => structuredClone(records),
			dispose: () => {
				closed = true;
			},
			disposed: () => closed,
		});
		fiber.addDisposer(() => {
			closed = true;
		});
	},
};

export const agentLoop: PluginDefinition = {
	apiVersion: 1,
	name: "agent-loop",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const selected = context.require(runtimeSelectionKey).selected();
		const memory = context.require(sessionStoreKey);
		const tools = context.get(toolRegistryKey)?.snapshot({
			workspace: context.require(workspaceCapabilityKey),
			process: context.require(processCapabilityKey),
			network: context.require(networkCapabilityKey),
			policy: context.require(toolPolicyKey),
			approval: context.require(toolApprovalKey),
			output: context.require(toolOutputKey),
		});
		const agent = new AgentImpl({ provider: selected.provider, model: selected.model, tools });
		const unsubscribe = agent.subscribe((event: AgentEvent) => memory.append(event));
		let closed = false;
		context.set(agentLoopKey, {
			agent,
			prompt: (prompt, signal) => {
				if (closed) return Promise.reject(new Error("Agent loop is disposed"));
				return agent.prompt(prompt, signal);
			},
			disposed: () => closed,
		});
		fiber.addDisposer(() => {
			closed = true;
			unsubscribe();
		});
	},
};

export const modePrint: PluginDefinition = {
	apiVersion: 1,
	name: "mode-print",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const commands = context.require(hostCommandRegistryKey);
		const run = async (input: unknown, signal?: AbortSignal): Promise<number> => {
			if (typeof input !== "object" || input === null) throw new Error("Print request is invalid");
			const request = input as PrintRequest;
			if (typeof request.prompt !== "string" || typeof request.stdout !== "function")
				throw new Error("Print request is invalid");
			const response = await context.require(agentLoopKey).prompt(request.prompt, signal);
			const text = response.content
				.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
				.map((content) => content.text)
				.join("");
			request.stdout(`${text}\n`);
			return 0;
		};
		const dispose = commands.register("print", run);
		fiber.addDisposer(dispose);
		const modes = context.get(modeRegistryKey);
		if (modes) fiber.addDisposer(modes.register({ name: "print", run }));
	},
};

export const minimalProfile = {
	entries: [
		{ id: "Bootstrap", name: "@di-code/builtins/bootstrap" },
		{ id: "command-core", name: "@di-code/builtins/command-core", dependsOn: ["Bootstrap"] },
		{ id: "cli-parser", name: "@di-code/builtins/cli-parser", dependsOn: ["command-core"] },
		{ id: "command-session", name: "@di-code/builtins/command-session", dependsOn: ["command-core"] },
		{ id: "command-model", name: "@di-code/builtins/command-model", dependsOn: ["command-core"] },
		{ id: "command-settings", name: "@di-code/builtins/command-settings", dependsOn: ["command-core"] },
		{ id: "command-compact", name: "@di-code/builtins/command-compact", dependsOn: ["command-core"] },
		{ id: "command-interactive-core", name: "@di-code/builtins/command-interactive-core", dependsOn: ["command-core"] },
		{ id: "theme", name: "@di-code/builtins/theme", dependsOn: ["command-core"] },
		{ id: "interactive-context", name: "@di-code/builtins/interactive-context", dependsOn: ["command-core"] },
		{ id: "tui-renderer", name: "@di-code/builtins/tui-renderer", dependsOn: ["command-core"] },
		{ id: "output-json", name: "@di-code/builtins/output-json", dependsOn: ["command-core"] },
		{ id: "runtime", name: "@di-code/builtins/runtime", dependsOn: ["Bootstrap"] },
		{ id: "diagnostics", name: "@di-code/builtins/diagnostics", dependsOn: ["runtime"] },
		{ id: "process-exit", name: "@di-code/builtins/process-exit", dependsOn: ["runtime"] },
		{ id: "provider-registry", name: "@di-code/builtins/provider-registry" },
		{ id: "model-catalog", name: "@di-code/builtins/model-catalog", dependsOn: ["provider-registry"] },
		{ id: "credential-env", name: "@di-code/builtins/credential-env", dependsOn: ["provider-registry"] },
		{ id: "provider-faux", name: "@di-code/builtins/provider-faux", dependsOn: ["provider-registry"] },
		{
			id: "provider-openai",
			name: "@di-code/builtins/provider-openai",
			dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
			required: false,
		},
		{
			id: "provider-anthropic",
			name: "@di-code/builtins/provider-anthropic",
			dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
			required: false,
		},
		{
			id: "provider-deepseek",
			name: "@di-code/builtins/provider-deepseek",
			dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
			required: false,
		},
		{
			id: "provider-kimi",
			name: "@di-code/builtins/provider-kimi",
			dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
			required: false,
		},
		{
			id: "provider-zhipu",
			name: "@di-code/builtins/provider-zhipu",
			dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
			required: false,
		},
		{ id: "runtime-selection", name: "@di-code/builtins/runtime-selection", dependsOn: ["provider-registry"] },
		{
			id: "provider-onboarding",
			name: "@di-code/builtins/provider-onboarding",
			dependsOn: ["provider-registry", "credential-env"],
			required: false,
		},
		{ id: "session-memory", name: "@di-code/builtins/session-memory", dependsOn: ["runtime"] },
		{ id: "tool-registry", name: "@di-code/builtins/tool-registry", dependsOn: ["runtime"] },
		{ id: "workspace", name: "@di-code/builtins/workspace", dependsOn: ["tool-registry"] },
		{ id: "process", name: "@di-code/builtins/process", dependsOn: ["tool-registry"] },
		{ id: "network", name: "@di-code/builtins/network", dependsOn: ["tool-registry"] },
		{ id: "tool-approval", name: "@di-code/builtins/tool-approval", dependsOn: ["tool-registry"] },
		{ id: "tool-policy", name: "@di-code/builtins/tool-policy", dependsOn: ["tool-registry"] },
		{ id: "tool-output", name: "@di-code/builtins/tool-output", dependsOn: ["tool-registry"] },
		{ id: "tool-read", name: "@di-code/builtins/tool-read", dependsOn: ["tool-registry", "workspace"] },
		{ id: "tool-write", name: "@di-code/builtins/tool-write", dependsOn: ["tool-registry", "workspace"] },
		{ id: "tool-edit", name: "@di-code/builtins/tool-edit", dependsOn: ["tool-registry", "workspace"] },
		{ id: "tool-bash", name: "@di-code/builtins/tool-bash", dependsOn: ["tool-registry", "workspace"] },
		{ id: "tool-glob", name: "@di-code/builtins/tool-glob", dependsOn: ["tool-registry", "workspace"] },
		{ id: "tool-grep", name: "@di-code/builtins/tool-grep", dependsOn: ["tool-registry", "workspace"] },
		{ id: "tool-load-skill", name: "@di-code/builtins/tool-load-skill", dependsOn: ["tool-registry", "workspace"] },
		{ id: "session-store-jsonl", name: "@di-code/builtins/session-store-jsonl", dependsOn: ["runtime"] },
		{ id: "session-tree", name: "@di-code/builtins/session-tree", dependsOn: ["session-store-jsonl"] },
		{ id: "session-query", name: "@di-code/builtins/session-query", dependsOn: ["session-store-jsonl"] },
		{ id: "usage-meter", name: "@di-code/builtins/usage-meter", dependsOn: ["runtime"] },
		{ id: "context-budget", name: "@di-code/builtins/context-budget", dependsOn: ["runtime"] },
		{ id: "compaction-basic", name: "@di-code/builtins/compaction-basic", dependsOn: ["context-budget"] },
		{ id: "system-prompt", name: "@di-code/builtins/system-prompt", dependsOn: ["runtime"] },
		{ id: "resource-loader", name: "@di-code/builtins/resource-loader", dependsOn: ["runtime"] },
		{ id: "skills", name: "@di-code/builtins/skills", dependsOn: ["resource-loader"] },
		{
			id: "agent-loop",
			name: "@di-code/builtins/agent-loop",
			dependsOn: [
				"runtime-selection",
				"provider-faux",
				"session-memory",
				"tool-registry",
				"workspace",
				"process",
				"network",
				"tool-approval",
				"tool-policy",
				"tool-output",
			],
		},
		{
			id: "agent-session",
			name: "@di-code/builtins/agent-session",
			dependsOn: ["provider-registry", "tool-registry", "system-prompt", "compaction-basic"],
		},
		{ id: "rpc-protocol-v1", name: "@di-code/builtins/rpc-protocol-v1", dependsOn: ["agent-session"] },
		{ id: "rpc-server", name: "@di-code/builtins/rpc-server", dependsOn: ["rpc-protocol-v1", "agent-session"] },
		{ id: "rpc-events", name: "@di-code/builtins/rpc-events", dependsOn: ["rpc-server"] },
		{ id: "mode-print", name: "@di-code/builtins/mode-print", dependsOn: ["Bootstrap", "command-core", "agent-loop"] },
		{ id: "mode-json", name: "@di-code/builtins/mode-json", dependsOn: ["command-core", "agent-loop"] },
		{ id: "mode-interactive", name: "@di-code/builtins/mode-interactive", dependsOn: ["command-core", "agent-loop"] },
	] as const,
};

export const pluginModules = {
	Bootstrap: bootstrap,
	cliParser,
	commandCore,
	commandSession,
	commandModel,
	commandSettings,
	commandCompact,
	commandInteractiveCore,
	modeJson,
	modeInteractive,
	tuiRenderer,
	theme,
	outputJson,
	interactiveContext,
	runtime,
	diagnostics,
	processExit,
	providerRegistry,
	providerFaux,
	providerOpenai,
	providerAnthropic,
	providerDeepseek,
	providerKimi,
	providerZhipu,
	modelCatalog,
	credentialEnv,
	runtimeSelection,
	providerOnboarding,
	toolRegistry,
	sessionStoreJsonl,
	sessionTree,
	sessionQuery,
	usageMeter,
	contextBudget,
	compactionBasic,
	compactionToolResult,
	sessionMigrations,
	systemPrompt,
	resourceLoader,
	skills,
	agentSession,
	rpcProtocolV1,
	rpcServer,
	rpcEvents,
	modeRpc,
	pluginProfiler,
	pluginInvariants,
	pluginTestRuntime,
	agentLoop,
	sessionMemory,
	modePrint,
} as const;
