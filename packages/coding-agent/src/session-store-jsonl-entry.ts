import { sessionMigrationRegistryKey, sessionStoreRegistryKey } from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { SessionManager } from "./core/session/session-manager.ts";

/** Registers the product JSONL SessionStore implementation behind the public registry. */
export const apiVersion = 1 as const;
export const name = "session-store-jsonl";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = (context, _config, fiber) => {
	const registry = context.require(sessionStoreRegistryKey);
	const migrations = context.require(sessionMigrationRegistryKey);
	fiber.addDisposer(
		registry.register("jsonl", {
			create: (options) => {
				if (!isCreateOptions(options)) throw new TypeError("JSONL SessionStore create options are invalid");
				return SessionManager.create(options);
			},
			open: async (filePath, options) => {
				await migrations.migrate(filePath);
				return await SessionManager.open(filePath, isOpenOptions(options) ? options : {});
			},
		}),
	);
};

function isCreateOptions(
	value: unknown,
): value is { readonly filePath: string; readonly cwd: string; readonly deferCreate?: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		"filePath" in value &&
		typeof value.filePath === "string" &&
		"cwd" in value &&
		typeof value.cwd === "string"
	);
}

function isOpenOptions(value: unknown): value is Record<string, unknown> {
	return value === undefined || (typeof value === "object" && value !== null);
}
