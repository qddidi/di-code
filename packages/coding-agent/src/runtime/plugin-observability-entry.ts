import type { EntryRecord, PluginInventory } from "@di-code/plugin-loader";
import { createServiceKey, type PluginDefinition, redactSensitiveText } from "@di-code/plugin-runtime";

type ObservationKind = "plugin_trace" | "plugin_dump_composition";

interface ObservedEntry {
	readonly id: string;
	readonly module: string;
	readonly phase: EntryRecord["status"];
	readonly required: boolean;
	readonly dependencies: readonly string[];
	readonly ownerFiber: { readonly id: string; readonly plugin: string; readonly status: string } | null;
	readonly capabilityAudit: {
		readonly trustedProject: boolean;
		readonly declared: readonly string[];
		readonly granted: readonly string[];
	};
	readonly failure?: string;
}

export interface PluginObservationService {
	readonly render: (inventory: PluginInventory) => string;
}

export const pluginTraceKey = createServiceKey<PluginObservationService>("plugin-trace");
export const pluginDumpCompositionKey = createServiceKey<PluginObservationService>("plugin-dump-composition");

function observe(record: EntryRecord): ObservedEntry {
	const fiber = record.fiber;
	const declared = fiber ? [...fiber.capabilities.declared].sort() : [];
	const managed = record.entry.id.startsWith("managed.");
	const module = managed ? `managed:${record.entry.id.slice("managed.".length)}` : record.entry.name;
	const failure = record.error
		? redactSensitiveText(record.error.message).replaceAll(record.entry.name, module)
		: undefined;
	return {
		id: record.entry.id,
		module,
		phase: record.status,
		required: record.entry.required !== false,
		dependencies: [...(record.entry.dependsOn ?? [])],
		ownerFiber: fiber ? { id: fiber.id, plugin: fiber.pluginName, status: fiber.status } : null,
		capabilityAudit: {
			trustedProject: fiber?.capabilities.trustedProject ?? false,
			declared,
			granted: declared.filter((capability) => fiber?.capabilities.has(capability) ?? false),
		},
		...(failure ? { failure } : {}),
	};
}

function service(kind: ObservationKind): PluginObservationService {
	return {
		render: (inventory) =>
			JSON.stringify({
				type: kind,
				resolvedTree: inventory.entries.map(observe),
			}),
	};
}

/** Opt-in development entry that serializes actual Loader phases and Fiber ownership. */
export const pluginTrace: PluginDefinition = {
	apiVersion: 1,
	name: "plugin-trace",
	version: "0.1.7",
	apply(context) {
		context.set(pluginTraceKey, service("plugin_trace"));
	},
};

/** Opt-in development entry that dumps the resolved composition without entry config values. */
export const pluginDumpComposition: PluginDefinition = {
	apiVersion: 1,
	name: "plugin-dump-composition",
	version: "0.1.7",
	apply(context) {
		context.set(pluginDumpCompositionKey, service("plugin_dump_composition"));
	},
};
