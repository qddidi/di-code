import { type Context, createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

export interface RuntimeCoreService {
	readonly context: Context;
	readonly mode: Context["mode"];
}

export const apiVersion = 1 as const;
export const name = "runtime-core";
export const version = "0.1.7";
export const runtimeCoreKey = createServiceKey<RuntimeCoreService>("runtime-core");
export const apply: PluginDefinition["apply"] = (context) => {
	context.set(runtimeCoreKey, { context, mode: context.mode });
};
