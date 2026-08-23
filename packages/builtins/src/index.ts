import type { FauxResponse, Model, Provider } from "@di-code/ai";
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

export interface MemorySessionStore {
	readonly append: (record: unknown) => void;
	readonly records: () => readonly unknown[];
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
	apply(context) {
		const records: unknown[] = [];
		context.set(sessionStoreKey, { append: (record) => records.push(record), records: () => [...records] });
	},
};

export const minimalProfile = {
	entries: [
		{ id: "provider-registry", name: "@di-code/builtins/provider-registry" },
		{ id: "provider-faux", name: "@di-code/builtins/provider-faux", dependsOn: ["provider-registry"] },
		{ id: "session-memory", name: "@di-code/builtins/session-memory" },
	] as const,
};

export const pluginModules = { providerRegistry, providerFaux, sessionMemory } as const;
