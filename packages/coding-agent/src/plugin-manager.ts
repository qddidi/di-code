import { pluginManager } from "./runtime/plugin-manager-entry.ts";

export {
	type PluginManagementAction,
	type PluginManagementCommand,
	type PluginManagerEntryConfig,
	type PluginManagerService,
	pluginManager,
	pluginManagerKey,
} from "./runtime/plugin-manager-entry.ts";
export const apiVersion = pluginManager.apiVersion;
export const name = pluginManager.name;
export const version = pluginManager.version;
export const apply = pluginManager.apply;
