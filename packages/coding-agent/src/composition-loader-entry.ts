import { type CompositionEntry, createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { type Context, createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

export interface CompositionLoaderService {
	readonly create: (
		entries: readonly CompositionEntry[],
		importModule: (name: string) => Promise<PluginModule>,
	) => ReturnType<typeof createCompositionLoader>;
}

export const apiVersion = 1 as const;
export const name = "composition-loader";
export const version = "0.1.7";
export const compositionLoaderKey = createServiceKey<CompositionLoaderService>("composition-loader");
export const apply: PluginDefinition["apply"] = (context: Context) => {
	context.set(compositionLoaderKey, {
		create: (entries, importModule) => createCompositionLoader({ context, entries, importModule }),
	});
};
