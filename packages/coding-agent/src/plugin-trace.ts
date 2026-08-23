import { pluginTrace } from "./runtime/plugin-observability-entry.ts";

export { type PluginObservationService, pluginTrace, pluginTraceKey } from "./runtime/plugin-observability-entry.ts";
export const apiVersion = pluginTrace.apiVersion;
export const name = pluginTrace.name;
export const version = pluginTrace.version;
export const apply = pluginTrace.apply;
