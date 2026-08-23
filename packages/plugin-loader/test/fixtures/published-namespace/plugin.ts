import type { PluginDefinition } from "@di-code/plugin-runtime";

export const apiVersion = 1 as const;
export const name = "fixture.published";
export const version = "1.0.0";
export const apply: PluginDefinition["apply"] = () => undefined;
