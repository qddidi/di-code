import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type CommandDefinition, commandRegistryKey } from "@di-code/builtins";
import { type ManagedPlugin, PluginInstallManager } from "@di-code/plugin-loader";
import { createServiceKey, type PluginDefinition, redactSensitiveText } from "@di-code/plugin-runtime";

export type PluginManagementAction = "install" | "list" | "get" | "enable" | "disable" | "update" | "remove";

export interface PluginManagementCommand {
	readonly action: PluginManagementAction;
	readonly argument?: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

export interface PluginManagerService {
	readonly execute: (command: PluginManagementCommand) => Promise<number>;
	readonly list: () => Promise<readonly ManagedPlugin[]>;
}

export interface PluginManagerEntryConfig {
	readonly agentDir?: string;
}

export const pluginManagerKey = createServiceKey<PluginManagerService>("plugin-manager");

function safeMessage(cause: unknown): string {
	return redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
}

function publicPlugin(plugin: ManagedPlugin): Readonly<Record<string, unknown>> {
	return {
		id: plugin.id,
		enabled: plugin.enabled,
		version: plugin.manifest.version,
		installedAt: plugin.installedAt,
		capabilities: Object.keys(plugin.manifest.capabilities).sort(),
	};
}

function isPluginManagementCommand(value: unknown): value is PluginManagementCommand {
	return (
		typeof value === "object" &&
		value !== null &&
		"action" in value &&
		typeof value.action === "string" &&
		"stdout" in value &&
		typeof value.stdout === "function" &&
		"stderr" in value &&
		typeof value.stderr === "function"
	);
}

/** Registers the composition-owned, non-provider plugin management command. */
export const pluginManager: PluginDefinition<PluginManagerEntryConfig> = {
	apiVersion: 1,
	name: "plugin-manager",
	version: "0.1.7",
	apply(context, config, fiber) {
		const agentDir = resolve(config?.agentDir ?? join(homedir(), ".di-code"));
		const manager = new PluginInstallManager({ managedRoot: join(agentDir, "plugins", "installed") });
		const service: PluginManagerService = {
			list: () => manager.list(),
			execute: async (command) => {
				try {
					switch (command.action) {
						case "list":
							for (const plugin of await manager.list())
								command.stdout(
									`${plugin.id}\t${plugin.enabled ? "enabled" : "disabled"}\t${plugin.manifest.version}\n`,
								);
							return 0;
						case "get": {
							const plugin = (await manager.list()).find((item) => item.id === command.argument);
							if (!plugin) throw new Error(`Unknown plugin: ${command.argument ?? ""}`);
							command.stdout(`${JSON.stringify(publicPlugin(plugin))}\n`);
							return 0;
						}
						case "install": {
							const plugin = await manager.install(command.argument ?? "");
							command.stdout(`Installed ${plugin.id}\n`);
							return 0;
						}
						case "enable":
							await manager.enable(command.argument ?? "");
							return 0;
						case "disable":
							await manager.disable(command.argument ?? "");
							return 0;
						case "update":
							{
								const current = (await manager.list()).find((item) => item.id === command.argument);
								if (!current) throw new Error(`Unknown plugin: ${command.argument ?? ""}`);
								const updated = await manager.install(current.source);
								if (!current.enabled) await manager.disable(updated.id);
							}
							return 0;
						case "remove":
							await manager.remove(command.argument ?? "");
							return 0;
					}
				} catch (cause) {
					command.stderr(`${safeMessage(cause)}\n`);
					return 1;
				}
			},
		};
		context.set(pluginManagerKey, service);
		const command: CommandDefinition = {
			name: "plugin",
			description: "Manage installed plugins",
			run: (input) => {
				if (!isPluginManagementCommand(input)) return Promise.reject(new Error("Plugin command input is invalid"));
				return service.execute(input);
			},
		};
		fiber.addDisposer(context.require(commandRegistryKey).register(command));
	},
};
