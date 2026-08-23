import { pluginInventory } from "./runtime/plugin-inventory-entry.ts";

export { type PluginInventoryService, pluginInventory, pluginInventoryKey } from "./runtime/plugin-inventory-entry.ts";
export const apiVersion = pluginInventory.apiVersion;
export const name = pluginInventory.name;
export const version = pluginInventory.version;
export const apply = pluginInventory.apply;
