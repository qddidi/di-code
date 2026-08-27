import { hostCommandRegistryKey } from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import type { CliCommand } from "./cli.ts";
import { addMcpConfig, getMcpConfig, listMcpConfig, type McpConfigScope, removeMcpConfig } from "./mcp/config.ts";

/** Registers the CLI MCP configuration command in the base composition. */
export const mcpCommand: PluginDefinition = {
	apiVersion: 1,
	name: "mcp-command",
	version: "0.1.9",
	apply(context, _config, fiber) {
		const registry = context.require(hostCommandRegistryKey);
		fiber.addDisposer(
			registry.register("mcp", async (input) => {
				const command = input as Extract<CliCommand, { kind: "mcp" }>;
				const cwd = (input as { readonly cwd?: string }).cwd ?? process.cwd();
				const scope: McpConfigScope = command.scope ?? "local";
				const stdout = (input as { readonly stdout?: (text: string) => void }).stdout ?? (() => undefined);
				const serverId = (): string => {
					if (!command.serverId) throw new Error("MCP server id is required.");
					return command.serverId;
				};
				switch (command.action) {
					case "list":
						stdout(`${JSON.stringify(await listMcpConfig(cwd, scope), null, 2)}\n`);
						return 0;
					case "get": {
						const id = serverId();
						const result = await getMcpConfig(cwd, id, command.scope);
						if (!result) throw new Error(`MCP server "${id}" was not found.`);
						stdout(`${JSON.stringify(result, null, 2)}\n`);
						return 0;
					}
					case "remove": {
						const id = serverId();
						await removeMcpConfig(cwd, scope, id);
						stdout(`Removed MCP server "${id}" from ${scope} scope.\n`);
						return 0;
					}
					case "add": {
						const id = serverId();
						if ((command.transport === "stdio" && !command.command) || (command.transport === "http" && !command.url))
							throw new Error("MCP command is incomplete.");
						await addMcpConfig(
							cwd,
							scope,
							id,
							command.transport === "stdio"
								? { type: "stdio", command: command.command, ...(command.args ? { args: command.args } : {}) }
								: { type: "http", url: command.url },
						);
						stdout(`Added MCP server "${id}" to ${scope} scope.\n`);
						return 0;
					}
				}
			}),
		);
	},
};

export const apiVersion = mcpCommand.apiVersion;
export const name = mcpCommand.name;
export const version = mcpCommand.version;
export const apply = mcpCommand.apply;
