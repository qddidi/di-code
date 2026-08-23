import { pluginDumpComposition } from "./runtime/plugin-observability-entry.ts";

export {
	type PluginObservationService,
	pluginDumpComposition,
	pluginDumpCompositionKey,
} from "./runtime/plugin-observability-entry.ts";
export const apiVersion = pluginDumpComposition.apiVersion;
export const name = pluginDumpComposition.name;
export const version = pluginDumpComposition.version;
export const apply = pluginDumpComposition.apply;
