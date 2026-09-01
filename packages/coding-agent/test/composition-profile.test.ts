import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bootstrap,
	commandCore,
	hostCommandRegistryKey,
	networkCapability,
	pluginModules,
	processCapability,
	toolApproval,
	toolBash,
	toolEdit,
	toolGlob,
	toolGrep,
	toolLoadSkill,
	toolOutput,
	toolPolicy,
	toolRead,
	toolWrite,
	workspace,
} from "@di-code/builtins";
import { createCompositionLoader, PluginInstallManager, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveDefaultComposition,
	resolveManagedCompositionEntries,
} from "../src/compositions.ts";
import { pluginManager } from "../src/runtime/plugin-manager-entry.ts";

const additionalBuiltinModules = [
	workspace,
	processCapability,
	networkCapability,
	toolApproval,
	toolPolicy,
	toolOutput,
	toolRead,
	toolWrite,
	toolEdit,
	toolBash,
	toolGlob,
	toolGrep,
	toolLoadSkill,
];

describe("default compositions", () => {
	it("loads every built-in entry from package-owned base and mode documents", async () => {
		const baseEntries = await resolveDefaultComposition("base");
		const base = new Set(baseEntries.map((entry) => entry.id));
		expect([...base]).toEqual(
			expect.arrayContaining(["plugin-manager", "plugin-inventory", "mcp-config", "tool-read", "session-store-jsonl"]),
		);
		for (const name of ["interactive", "print", "json", "rpc"] as const) {
			const resolved = await resolveDefaultComposition(name);
			expect(new Set(resolved.map((entry) => entry.id)).size).toBe(resolved.length);
			expect(resolved.map((entry) => entry.id)).toContain("Bootstrap");
		}
		expect((await resolveDefaultComposition("print")).map((entry) => entry.id)).toContain("mode-print");
		expect((await resolveDefaultComposition("json")).map((entry) => entry.id)).toContain("mode-json");
		expect((await resolveDefaultComposition("interactive")).map((entry) => entry.id)).toContain("mode-interactive");
		const rpcEntries = await resolveDefaultComposition("rpc");
		expect(rpcEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "session-factory", name: "@di-code/coding-agent/session-factory-entry" }),
				expect.objectContaining({ id: "rpc-protocol-v1", dependsOn: ["session-factory"] }),
				expect.objectContaining({ id: "rpc-server", name: "@di-code/coding-agent/rpc-server-entry" }),
			]),
		);
		expect((await resolveDefaultComposition("print")).map((entry) => entry.id)).not.toContain("plugin-trace");
		expect((await resolveDefaultComposition("print", { observability: true })).map((entry) => entry.id)).toEqual(
			expect.arrayContaining(["plugin-trace", "plugin-dump-composition"]),
		);
	});

	it("loads the interactive mode through Loader without the print/json Agent loop", async () => {
		const context = createRootContext({ id: "interactive-composition", mode: "interactive", trustedProject: true });
		const baseEntries = await resolveDefaultComposition("base");
		const interactiveEntries = await resolveDefaultComposition("interactive");
		const entries = [
			...baseEntries,
			...interactiveEntries.filter((entry) => !baseEntries.some((baseEntry) => baseEntry.id === entry.id)),
		];
		const loader = createCompositionLoader({
			context,
			entries,
			importModule: async (name) => {
				if (name.startsWith("@di-code/builtins/")) {
					const entryName = name.slice("@di-code/builtins/".length);
					const plugin = [...Object.values(pluginModules), ...additionalBuiltinModules].find(
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
			const baseEntries = await resolveDefaultComposition("base");
			const bootstrapEntry = baseEntries.find((entry) => entry.id === "Bootstrap");
			if (bootstrapEntry === undefined) throw new Error("Missing Bootstrap entry in base composition.");
			const loader = createCompositionLoader({
				context,
				entries: [bootstrapEntry, ...entries],
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

	it("merges user, project, and explicit composition layers in order", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-composition-layers-"));
		const agentDir = join(root, "agent");
		const explicitPath = join(root, "explicit.yml");
		try {
			await mkdir(join(root, ".di-code"), { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "composition.yml"), "patches:\n  - op: disable\n    id: tool-write\n");
			await writeFile(
				join(root, ".di-code", "composition.yml"),
				"entries:\n  - id: project-entry\n    name: test-project-entry\npatches:\n  - op: disable\n    id: tool-read\n",
			);
			await writeFile(explicitPath, "patches:\n  - op: enable\n    id: tool-read\n");

			const resolved = await resolveCompositionEntries("print", {
				cwd: root,
				agentDir,
				compositionPath: explicitPath,
				allowedRoot: root,
			});
			expect(resolved.find((entry) => entry.id === "tool-read")?.disabled).toBe(false);
			expect(resolved.find((entry) => entry.id === "tool-write")?.disabled).toBe(true);
			expect(resolved.find((entry) => entry.id === "project-entry")?.projectLocal).toBe(true);
			expect(resolved.find((entry) => entry.id === "workspace")?.config).toMatchObject({ allowedRoot: root });

			const withoutProject = await resolveCompositionEntries("print", {
				cwd: root,
				agentDir,
				includeProjectComposition: false,
				allowedRoot: root,
			});
			expect(withoutProject.find((entry) => entry.id === "tool-read")?.disabled).toBeUndefined();
			expect(withoutProject.find((entry) => entry.id === "project-entry")).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("routes the default interactive entry through the composition host command", async () => {
		const source = await readFile(join(process.cwd(), "src", "entry.ts"), "utf8");

		expect(source).toContain('import { runMinimalProfile } from "./main.ts";');
		expect(source).not.toContain("interactive-profile");
	});
});

describe("plugin-manager composition command", () => {
	it("creates a built project plugin and explains how to trust its automatic registration", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-create-"));
		const output: string[] = [];
		const errors: string[] = [];
		const npmCalls: Array<{ readonly args: readonly string[]; readonly cwd: string }> = [];
		const context = createRootContext({ id: "plugin-create" });
		try {
			await context.plugin(bootstrap, undefined);
			await context.plugin(commandCore, undefined);
			await context.plugin(pluginManager, {
				agentDir: join(root, "agent"),
				runNpm: async (args, cwd) => {
					npmCalls.push({ args, cwd });
					if (cwd.includes(".broken.creating-")) throw new Error("simulated npm failure");
					if (args[0] === "run") {
						await mkdir(join(cwd, "dist"), { recursive: true });
						await writeFile(join(cwd, "dist", "plugin.js"), "export default () => {};\n");
					}
				},
			});
			const registry = context.require(hostCommandRegistryKey);
			expect(
				await registry.execute("plugin", {
					action: "create",
					argument: "Hello Plugin",
					cwd: root,
					stdout: (text: string) => output.push(text),
					stderr: (text: string) => errors.push(text),
				}),
			).toBe(0);
			const pluginRoot = join(root, ".di-code", "plugins", "hello-plugin");
			expect(await readFile(join(pluginRoot, "dist", "plugin.js"), "utf8")).toContain("export default");
			expect(npmCalls.map((call) => call.args)).toEqual([
				["install", "--ignore-scripts"],
				["run", "build"],
			]);
			expect(output.join("")).toContain(`Created and built project plugin hello-plugin at ${pluginRoot}`);
			expect(output.join("")).toContain("di-code plugin trust .");
			expect(errors).toEqual([]);
			expect(
				await registry.execute("plugin", {
					action: "create",
					argument: "broken",
					cwd: root,
					stdout: (text: string) => output.push(text),
					stderr: (text: string) => errors.push(text),
				}),
			).toBe(1);
			await expect(readFile(join(root, ".di-code", "plugins", "broken", "package.json"), "utf8")).rejects.toThrow();
			expect(errors.join("")).toContain("simulated npm failure");
		} finally {
			await context.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs install, list, get, enable, disable, update, and remove through HostCommandRegistry", async () => {
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
			await context.plugin(bootstrap, undefined);
			await context.plugin(commandCore, undefined);
			await context.plugin(pluginManager, { agentDir: join(root, "agent") });
			const registry = context.require(hostCommandRegistryKey);
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
