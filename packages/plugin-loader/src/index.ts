import type { PluginDefinition } from "@di-code/plugin-runtime";

export type PluginModule<Config = unknown> = {
	readonly [exportName: string]: unknown;
} & Partial<PluginDefinition<Config>>;

export function isPluginDefinition(value: unknown): value is PluginDefinition {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly apply?: unknown };
	return typeof candidate.name === "string" && candidate.name.length > 0 && typeof candidate.apply === "function";
}

export function getPluginDefinition<Config = unknown>(module: PluginModule<Config>): PluginDefinition<Config> {
	if ("default" in module && module.default !== undefined) {
		throw new TypeError("Plugin modules must use namespace exports and cannot define a default export");
	}
	if (!isPluginDefinition(module)) {
		throw new TypeError("Plugin module must export a non-empty name and an apply function");
	}
	return module as PluginDefinition<Config>;
}
