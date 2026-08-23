import type { PluginInventory } from "@di-code/plugin-loader";
import { createServiceKey } from "@di-code/plugin-runtime";

/** Loader inventory projection consumed by bootstrap and observation entries. */
export interface PluginInventoryService {
	readonly set: (inventory: PluginInventory) => void;
	readonly snapshot: () => PluginInventory | undefined;
}

export const pluginInventoryKey = createServiceKey<PluginInventoryService>("plugin-inventory");
