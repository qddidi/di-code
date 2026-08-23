import type { Agent, AgentEvent } from "@di-code/agent";
import { Agent as AgentImpl } from "@di-code/agent";
import type { AssistantMessage, FauxResponse, Model, Provider } from "@di-code/ai";
import { createFauxProvider } from "@di-code/ai";
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

export interface ProviderSelection {
	readonly provider: Provider;
	readonly model: Model;
}

export interface ProviderRegistry {
	readonly register: (selection: ProviderSelection) => void;
	readonly list: () => readonly ProviderSelection[];
	readonly select: (providerId: string, modelId?: string) => ProviderSelection;
}

export const providerRegistryKey = createServiceKey<ProviderRegistry>("provider-registry");
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
	const entries: ProviderSelection[] = [];
	return {
		register(selection) {
			if (entries.some((entry) => entry.provider.id === selection.provider.id))
				throw new Error(`Duplicate provider: ${selection.provider.id}`);
			entries.push(selection);
		},
		list: () => entries.map((entry) => ({ ...entry })),
		select(providerId, modelId) {
			const entry = entries.find((candidate) => candidate.provider.id === providerId);
			if (!entry) throw new Error(`Unknown provider: ${providerId}`);
			const model =
				modelId === undefined ? entry.model : entry.provider.models.find((candidate) => candidate.id === modelId);
			if (!model) throw new Error(`Unknown model "${modelId}" for provider "${providerId}"`);
			return { provider: entry.provider, model };
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
		const selected = context.require(providerRegistryKey).select("faux");
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
		{ id: "provider-faux", name: "@di-code/builtins/provider-faux", dependsOn: ["provider-registry"] },
		{ id: "session-memory", name: "@di-code/builtins/session-memory", dependsOn: ["runtime"] },
		{ id: "agent-loop", name: "@di-code/builtins/agent-loop", dependsOn: ["provider-faux", "session-memory"] },
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
	agentLoop,
	sessionMemory,
	modePrint,
} as const;
