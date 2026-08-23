import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootstrap } from "@di-code/builtins";
import { createCompositionLoader, PluginInstallManager } from "@di-code/plugin-loader";
import { createRootContext, type PluginDefinition } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import { resolveManagedCompositionEntries } from "../src/compositions.ts";

function namespaceModule<T>(definition: PluginDefinition<T>) {
	return {
		apiVersion: definition.apiVersion ?? 1,
		name: definition.name,
		...(definition.version === undefined ? {} : { version: definition.version }),
		apply: (
			context: Parameters<PluginDefinition<T>["apply"]>[0],
			config: unknown,
			fiber: Parameters<PluginDefinition<T>["apply"]>[2],
		) => definition.apply(context, config as T, fiber),
	};
}

describe("published plugin smoke e2e", () => {
	it("loads, disables, unloads, and reloads a package-export plugin that only depends on the public SDK", async () => {
		const root = await mkdtemp(join(process.cwd(), ".published-plugin-smoke-"));
		const source = join(root, "published-plugin");
		const agentDir = join(root, "agent");
		try {
			await mkdir(source, { recursive: true });
			await writeFile(
				join(source, "package.json"),
				JSON.stringify({
					name: "@fixture/published-plugin",
					version: "1.0.0",
					type: "module",
					exports: { "./plugin": "./plugin.mjs" },
					dependencies: { "@di-code/plugin-sdk": "0.1.7" },
					diCode: {
						apiVersion: 1,
						plugins: ["./plugin"],
						permissions: { filesystem: "none", network: [], process: [] },
					},
				}),
				"utf8",
			);
			await writeFile(
				join(source, "plugin.mjs"),
				[
					'import { createServiceKey } from "@di-code/plugin-sdk";',
					'const publishedPluginKey = createServiceKey("published-plugin");',
					"export const apiVersion = 1;",
					'export const name = "published-plugin";',
					'export const version = "1.0.0";',
					'export const apply = (context) => context.set(publishedPluginKey, "loaded");',
					"",
				].join("\n"),
				"utf8",
			);
			const manager = new PluginInstallManager({ managedRoot: join(agentDir, "plugins", "installed") });
			await manager.installLocal(source);
			const installedSource = await readFile(join(source, "plugin.mjs"), "utf8");
			expect(installedSource).toContain('from "@di-code/plugin-sdk"');
			expect(installedSource).not.toContain("@di-code/plugin-runtime/");
			expect(installedSource).not.toContain("@di-code/plugin-loader/");

			const entries = await resolveManagedCompositionEntries(agentDir);
			expect(entries).toHaveLength(1);
			const firstContext = createRootContext({ id: "published-first", mode: "test", trustedProject: true });
			const firstLoader = createCompositionLoader({
				context: firstContext,
				entries: [{ id: "Bootstrap", name: "bootstrap" }, ...entries],
				importModule: async (name) => {
					if (name === "bootstrap") return namespaceModule(bootstrap);
					return await import(name);
				},
			});
			try {
				expect((await firstLoader.load()).get("managed.published-plugin")?.status).toBe("active");
			} finally {
				await firstLoader.dispose();
				await firstContext.dispose();
			}

			await manager.disable("published-plugin");
			expect(await resolveManagedCompositionEntries(agentDir)).toEqual([]);
			await manager.enable("published-plugin");
			const secondContext = createRootContext({ id: "published-second", mode: "test", trustedProject: true });
			const secondLoader = createCompositionLoader({
				context: secondContext,
				entries: [{ id: "Bootstrap", name: "bootstrap" }, ...(await resolveManagedCompositionEntries(agentDir))],
				importModule: async (name) => {
					if (name === "bootstrap") return namespaceModule(bootstrap);
					return await import(name);
				},
			});
			try {
				expect((await secondLoader.load()).get("managed.published-plugin")?.status).toBe("active");
			} finally {
				await secondLoader.dispose();
				await secondContext.dispose();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
