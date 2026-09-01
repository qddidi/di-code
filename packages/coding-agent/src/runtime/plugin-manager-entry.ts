import { spawn } from "node:child_process";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { hostCommandRegistryKey } from "@di-code/builtins";
import {
	type ManagedPlugin,
	PluginInstallManager,
	ProjectTrustStore,
	readPackagePluginManifest,
	resolvePackagePluginExport,
} from "@di-code/plugin-loader";
import { createServiceKey, type PluginDefinition, redactSensitiveText } from "@di-code/plugin-runtime";

export type PluginManagementAction =
	| "install"
	| "list"
	| "get"
	| "enable"
	| "disable"
	| "update"
	| "remove"
	| "create"
	| "doctor"
	| "trust"
	| "revoke";

export interface PluginManagementCommand {
	readonly action: PluginManagementAction;
	readonly argument?: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly cwd?: string;
}

export interface PluginManagerService {
	readonly execute: (command: PluginManagementCommand) => Promise<number>;
	readonly list: () => Promise<readonly ManagedPlugin[]>;
}

export interface PluginManagerEntryConfig {
	readonly agentDir?: string;
	/** Internal command seam used by the plugin scaffold test. */
	readonly runNpm?: (args: readonly string[], cwd: string) => Promise<void>;
}

export const pluginManagerKey = createServiceKey<PluginManagerService>("plugin-manager");

function safeMessage(cause: unknown): string {
	return redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (cause) {
		if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return false;
		throw cause;
	}
}

/** Runs the controlled npm commands used to materialize a newly scaffolded local plugin. */
async function runNpm(args: readonly string[], cwd: string): Promise<void> {
	await new Promise<void>((resolveResult, reject) => {
		const npmCommand = "npm";
		const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npmCommand;
		// Scaffold arguments are fixed internally, so cmd.exe never receives user-controlled command text.
		const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", `${npmCommand} ${args.join(" ")}`] : args;
		const child = spawn(command, commandArgs, { cwd, stdio: "ignore", windowsHide: true });
		const timeout = setTimeout(() => child.kill(), 5 * 60 * 1000);
		child.once("error", (cause) => {
			clearTimeout(timeout);
			reject(cause);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolveResult();
			else reject(new Error(`${npmCommand} ${args.join(" ")} failed while creating the plugin`));
		});
	});
}

function pluginId(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "my-plugin"
	);
}

function publicPlugin(plugin: ManagedPlugin): Readonly<Record<string, unknown>> {
	return {
		id: plugin.id,
		enabled: plugin.enabled,
		version: plugin.manifest.version,
		installedAt: plugin.installedAt,
		capabilities: Object.keys(plugin.manifest.capabilities ?? {}).sort(),
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
		const scaffoldNpm = config?.runNpm ?? runNpm;
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
						case "create": {
							const name = command.argument ?? "my-plugin";
							if (name.includes("/") || name.includes("\\") || name.includes(sep))
								throw new Error("Plugin create expects a plugin name, not a path.");
							const workspace = resolve(command.cwd ?? process.cwd());
							const id = pluginId(basename(name));
							const pluginsRoot = join(workspace, ".di-code", "plugins");
							const root = join(pluginsRoot, id);
							if (await pathExists(root)) throw new Error(`Plugin directory already exists: ${root}`);
							const staging = join(pluginsRoot, `.${id}.creating-${process.pid}-${Date.now()}`);
							await mkdir(staging, { recursive: true });
							try {
								await writeFile(
									join(staging, "package.json"),
									`${JSON.stringify({ name: id, version: "0.1.0", type: "module", exports: { ".": "./dist/plugin.js" }, scripts: { build: "tsc" }, dependencies: { "@di-code/plugin-sdk": "^0.2.4" }, devDependencies: { typescript: "^5.9.3" } }, null, 2)}\n`,
								);
								await writeFile(
									join(staging, "tsconfig.json"),
									`${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: ".", strict: true }, include: ["plugin.ts"] }, null, 2)}\n`,
								);
								await writeFile(
									join(staging, "plugin.ts"),
									`import type { ExtensionAPI } from "@di-code/plugin-sdk";\n\nexport default function setup(api: ExtensionAPI): void {\n  api.registerCommand("hello", { description: "Say hello", handler: async () => "Hello from ${id}" });\n}\n`,
								);
								await scaffoldNpm(["install", "--ignore-scripts"], staging);
								await scaffoldNpm(["run", "build"], staging);
								await rename(staging, root);
							} catch (cause) {
								await rm(staging, { recursive: true, force: true });
								throw cause;
							}
							const trusted = await new ProjectTrustStore(join(agentDir, "trust.json")).get(workspace);
							command.stdout(`Created and built project plugin ${id} at ${root}\n`);
							if (trusted) command.stdout("The trusted project will load it the next time di-code starts.\n");
							else command.stdout("Trust this project before loading it: di-code plugin trust .\n");
							return 0;
						}
						case "doctor": {
							const root = resolve(command.cwd ?? process.cwd(), command.argument ?? ".");
							const manifest = await readPackagePluginManifest(root);
							await resolvePackagePluginExport(root, manifest.entry);
							command.stdout(`Plugin ${manifest.id} is healthy (entry ${manifest.entry})\n`);
							return 0;
						}
						case "trust":
						case "revoke": {
							const root = resolve(command.argument ?? command.cwd ?? process.cwd());
							await new ProjectTrustStore(join(agentDir, "trust.json")).set(root, command.action === "trust");
							command.stdout(`${command.action === "trust" ? "Trusted" : "Revoked trust for"} ${root}\n`);
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
		const hostCommands = context.get(hostCommandRegistryKey);
		if (hostCommands) {
			fiber.addDisposer(
				hostCommands.register("plugin", (input) => {
					if (!isPluginManagementCommand(input)) return Promise.reject(new Error("Plugin command input is invalid"));
					return service.execute(input);
				}),
			);
		}
	},
};
