import type { PluginDefinition } from "@di-code/plugin-runtime";
import { installAgentSessionFactory } from "./runtime/session-factory.ts";

/** Installs the product SessionFactory as a composition-owned entry. */
export const apiVersion = 1 as const;
export const name = "session-factory";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = (context, _config, fiber) => {
	fiber.addDisposer(installAgentSessionFactory(context));
};
