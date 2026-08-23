import type { PluginDefinition } from "@di-code/plugin-runtime";
import { createReadTool } from "./tool-read-implementation.ts";
import { toolRegistryKey } from "./tool-registry.ts";

export const toolRead: PluginDefinition = {
	apiVersion: 1,
	name: "tool-read",
	version: "0.1.7",
	apply(context, _config, fiber) {
		const dispose = context
			.require(toolRegistryKey)
			.registerFactory("read", (capabilities) => createReadTool(capabilities.workspace.allowedRoot));
		fiber.addDisposer(dispose);
	},
};

export const apiVersion = toolRead.apiVersion;
export const name = toolRead.name;
export const version = toolRead.version;
export const apply = toolRead.apply;
