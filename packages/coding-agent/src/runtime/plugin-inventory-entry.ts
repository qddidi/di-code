import type { PluginInventory } from "@di-code/plugin-loader";
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

export interface PluginInventoryService {
	readonly set: (inventory: PluginInventory) => void;
	readonly snapshot: () => PluginInventory | undefined;
}

export const pluginInventoryKey = createServiceKey<PluginInventoryService>("plugin-inventory");

/** Stores the Loader-owned inventory without duplicating lifecycle state. */
export const pluginInventory: PluginDefinition = {
	apiVersion: 1,
	name: "plugin-inventory",
	version: "0.1.7",
	apply(context) {
		let inventory: PluginInventory | undefined;
		context.set(pluginInventoryKey, {
			set: (value) => {
				inventory = value;
			},
			snapshot: () => inventory,
		});
	},
};
