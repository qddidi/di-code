import type { PluginInventory } from "@di-code/plugin-loader";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { pluginInventoryKey } from "./plugin-inventory-service.ts";

export { type PluginInventoryService, pluginInventoryKey } from "./plugin-inventory-service.ts";

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
