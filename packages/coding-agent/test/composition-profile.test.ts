import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCore, commandRegistryKey, pluginModules } from "@di-code/builtins";
import { createCompositionLoader, PluginInstallManager, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	defaultCompositions,
	importCompositionModule,
	resolveDefaultComposition,
	resolveManagedCompositionEntries,
} from "../src/compositions.ts";
import { pluginManager } from "../src/runtime/plugin-manager-entry.ts";

describe("default compositions", () => {
	it("assigns every built-in entry to base or exactly one mode composition", () => {
		const base = new Set(defaultCompositions.base.map((entry) => entry.id));
		expect([...base]).toEqual(
			expect.arrayContaining(["plugin-manager", "plugin-inventory", "mcp-config", "tool-read", "session-store-jsonl"]),
		);
		for (const name of ["interactive", "print", "json", "rpc"] as const) {
			const resolved = resolveDefaultComposition(name);
			expect(new Set(resolved.map((entry) => entry.id)).size).toBe(resolved.length);
			expect(resolved.map((entry) => entry.id)).toContain("Bootstrap");
		}
		expect(resolveDefaultComposition("print").map((entry) => entry.id)).toContain("mode-print");
		expect(resolveDefaultComposition("json").map((entry) => entry.id)).toContain("mode-json");
		expect(resolveDefaultComposition("interactive").map((entry) => entry.id)).toContain("mode-interactive");
		expect(resolveDefaultComposition("rpc").map((entry) => entry.id)).toContain("rpc-protocol-v1");
		expect(resolveDefaultComposition("print").map((entry) => entry.id)).not.toContain("plugin-trace");
		expect(resolveDefaultComposition("print", { observability: true }).map((entry) => entry.id)).toEqual(
			expect.arrayContaining(["plugin-trace", "plugin-dump-composition"]),
		);
	});

	it("loads the interactive mode through Loader without the print/json Agent loop", async () => {
		const context = createRootContext({ id: "interactive-composition", mode: "interactive", trustedProject: true });
		const entries = [
			...defaultCompositions.base.filter((entry) => entry.id === "Bootstrap" || entry.id === "command-core"),
			...defaultCompositions.interactive,
		];
		const loader = createCompositionLoader({
			context,
			entries,
			importModule: async (name) => {
				if (name.startsWith("@di-code/builtins/")) {
					const entryName = name.slice("@di-code/builtins/".length);
					const plugin = Object.values(pluginModules).find(
						(entry) => entry.name === (entryName === "bootstrap" ? "Bootstrap" : entryName),
					);
					if (!plugin) throw new Error(`Missing builtins fixture entry: ${name}`);
					return plugin as PluginModule;
				}
				return await importCompositionModule(name);
			},
			projectTrusted: true,
		});
		try {
			const inventory = await loader.load();
			expect(inventory.get("mode-interactive")?.status).toBe("active");
			expect(inventory.get("agent-loop")).toBeUndefined();
		} finally {
			await loader.dispose();
			await context.dispose();
		}
	});

	it("does not add or import disabled managed plugins", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-managed-composition-"));
		const source = join(root, "source");
		const agentDir = join(root, "agent");
		try {
			await mkdir(source, { recursive: true });
			await writeFile(
				join(source, "package.json"),
				JSON.stringify({
					name: "managed-plugin",
					version: "1.0.0",
					type: "module",
					exports: { "./plugin": "./index.mjs" },
					diCode: {
						apiVersion: 1,
						plugins: ["./plugin"],
						permissions: { filesystem: "none", network: [], process: [] },
						capabilities: {},
					},
				}),
			);
			await writeFile(
				join(source, "index.mjs"),
				"export const apiVersion = 1; export const name = 'managed-plugin'; export const apply = () => undefined;",
			);
			const manager = new PluginInstallManager({ managedRoot: join(agentDir, "plugins", "installed") });
			await manager.installLocal(source);
			await manager.disable("managed-plugin");

			expect(await resolveManagedCompositionEntries(agentDir)).toEqual([]);

			await manager.enable("managed-plugin");
			const entries = await resolveManagedCompositionEntries(agentDir);
			expect(entries.map((entry) => entry.id)).toEqual(["managed.managed-plugin"]);
			const imports: string[] = [];
			const context = createRootContext({ id: "managed-composition" });
			const loader = createCompositionLoader({
				context,
				entries: [defaultCompositions.base[0], ...entries],
				importModule: async (name) => {
					imports.push(name);
					if (name === "@di-code/builtins/bootstrap") {
						return pluginModules.Bootstrap as PluginModule;
					}
					return (await import(name)) as PluginModule;
				},
			});
			try {
				await loader.load();
				expect(imports).toHaveLength(2);
				expect(imports.some((name) => name.includes("managed-plugin"))).toBe(true);
			} finally {
				await loader.dispose();
				await context.dispose();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("routes the default interactive entry through the composition profile", async () => {
		const source = await readFile(join(process.cwd(), "src", "entry.ts"), "utf8");

		expect(source).toContain('import { runInteractiveProfile } from "./interactive-profile.ts";');
	});
});

describe("plugin-manager composition command", () => {
	it("runs install, list, get, enable, disable, update, and remove through CommandRegistry", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-command-"));
		const source = join(root, "source");
		const output: string[] = [];
		const errors: string[] = [];
		const context = createRootContext({ id: "plugin-command" });
		try {
			await mkdir(source, { recursive: true });
			await writeFile(
				join(source, "package.json"),
				JSON.stringify({
					name: "managed",
					version: "1.0.0",
					type: "module",
					exports: { "./plugin": "./index.mjs" },
					diCode: {
						apiVersion: 1,
						plugins: ["./plugin"],
						permissions: { filesystem: "none", network: [], process: [] },
						capabilities: { filesystem: true },
					},
				}),
			);
			await writeFile(
				join(source, "index.mjs"),
				"export const name='managed'; export const version='1'; export const apply=()=>{};",
			);
			await context.plugin(commandCore, undefined);
			await context.plugin(pluginManager, { agentDir: join(root, "agent") });
			const registry = context.require(commandRegistryKey);
			const execute = async (
				action: "install" | "list" | "get" | "enable" | "disable" | "update" | "remove",
				argument?: string,
			) =>
				await registry.execute("plugin", {
					action,
					...(argument ? { argument } : {}),
					stdout: (text: string) => output.push(text),
					stderr: (text: string) => errors.push(text),
				});

			expect(await execute("install", source)).toBe(0);
			expect(await execute("list")).toBe(0);
			expect(await execute("get", "managed")).toBe(0);
			expect(await execute("disable", "managed")).toBe(0);
			expect(await execute("enable", "managed")).toBe(0);
			expect(await execute("update", "managed")).toBe(0);
			expect(await execute("remove", "managed")).toBe(0);
			expect(output.join("")).toContain("managed\tenabled\t1.0.0");
			expect(output.join("")).toContain('"capabilities":["filesystem"]');
			expect(errors).toEqual([]);
		} finally {
			await context.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
