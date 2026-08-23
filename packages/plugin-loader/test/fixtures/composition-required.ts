import type { PluginDefinition } from "@di-code/plugin-runtime";

export const name = "fixture.required";
export const version = "0.0.0-test";
export const apply: PluginDefinition["apply"] = (_context, config) => {
	if (config && typeof config === "object" && "fail" in config && config.fail === true)
		throw new Error("fixture failure");
};
