import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "@di-code/agent";
import { Agent as AgentImpl } from "@di-code/agent";
import type { AssistantMessage, FauxResponse, Model, Provider, ThinkingLevel } from "@di-code/ai";
import {
	createAnthropicProvider,
	createDeepSeekProvider,
	createFauxProvider,
	createKimiProvider,
	createOpenAIProvider,
	createZhipuProvider,
	MODELS,
} from "@di-code/ai";
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

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
	readonly select: (providerId: string, modelId?: string) => ProviderSelection;
}

export const providerRegistryKey = createServiceKey<ProviderRegistry>("provider-registry");
export const modelCatalogKey = createServiceKey<ModelCatalog>("model-catalog");
export const credentialEnvKey = createServiceKey<CredentialEnv>("credential-env");
export const runtimeSelectionKey = createServiceKey<RuntimeSelection>("runtime-selection");
export const runtimeConfigKey = createServiceKey<RuntimeProviderConfig>("runtime-config");
export const sessionStoreKey = createServiceKey<MemorySessionStore>("session-store");
export const hostCommandRegistryKey = createServiceKey<HostCommandRegistry>("host-command-registry");
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

export interface PrintRequest {
	readonly prompt: string;
	readonly stdout: (text: string) => void;
}

export interface AgentLoopService {
	readonly prompt: (prompt: string, signal?: AbortSignal) => Promise<AssistantMessage>;
	readonly agent: Agent;
	readonly disposed: () => boolean;
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

export const providerRegistry: PluginDefinition = {
	apiVersion: 1,
	name: "provider-registry",
	version: "0.1.7",
	apply(context) {
		context.set(providerRegistryKey, createRegistry());
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
		const report = (record: RuntimeDiagnostic): void => {
			records.push(Object.freeze({ ...record }));
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
				return registry.select(selectedProviderId, process.env.DI_CODE_MODEL?.trim() || modelId);
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
		const agent = new AgentImpl({ provider: selected.provider, model: selected.model });
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
		const dispose = commands.register("print", async (input: unknown, signal?: AbortSignal): Promise<number> => {
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
		});
		fiber.addDisposer(dispose);
	},
};

export const minimalProfile = {
	entries: [
		{ id: "Bootstrap", name: "@di-code/builtins/bootstrap" },
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
		{
			id: "agent-loop",
			name: "@di-code/builtins/agent-loop",
			dependsOn: ["runtime-selection", "provider-faux", "session-memory"],
		},
		{ id: "mode-print", name: "@di-code/builtins/mode-print", dependsOn: ["Bootstrap", "agent-loop"] },
	] as const,
};

export const pluginModules = {
	Bootstrap: bootstrap,
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
	agentLoop,
	sessionMemory,
	modePrint,
} as const;
