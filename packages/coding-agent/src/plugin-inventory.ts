import { pluginInventory } from "./runtime/plugin-inventory-entry.ts";

export { pluginInventory } from "./runtime/plugin-inventory-entry.ts";
export { type PluginInventoryService, pluginInventoryKey } from "./runtime/plugin-inventory-service.ts";
export const apiVersion = pluginInventory.apiVersion;
export const name = pluginInventory.name;
export const version = pluginInventory.version;
export const apply = pluginInventory.apply;
