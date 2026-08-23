import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	createCompositionLoader,
	getPluginDefinition,
	isPluginDefinition,
	mergeCompositionLayers,
	PluginInstallManager,
	ProjectTrustStore,
	parseComposition,
	readPackagePluginManifest,
	resolvePackagePluginExport,
	topologicallySortEntries,
} from "../src/index.ts";
import * as fixture from "./fixtures/namespace-plugin.ts";

describe("namespace plugin loader contract", () => {
	it("reads package diCode metadata and keeps entry inside the package root", async () => {
		const root = new URL("./fixtures/composition-plugin/", import.meta.url);
		const rootPath = fileURLToPath(root);
		const manifest = await readPackagePluginManifest(rootPath);
		expect(manifest.id).toBe("composition-plugin");
		expect(await resolvePackagePluginExport(rootPath, manifest.entry)).toMatch(/plugin\.ts$/);
	});
	it("loads a published namespace package only through its declared export", async () => {
		const rootPath = fileURLToPath(new URL("./fixtures/published-namespace/", import.meta.url));
		const manifest = await readPackagePluginManifest(rootPath);
		expect(manifest.entry).toBe("./plugin");
		expect(await resolvePackagePluginExport(rootPath, "./plugin")).toMatch(/plugin\.ts$/u);
	});
	it("rejects missing package exports before import", async () => {
		const rootPath = fileURLToPath(new URL("./fixtures/missing-export/", import.meta.url));
		await expect(readPackagePluginManifest(rootPath)).rejects.toThrow(/not declared/iu);
	});
	it("loads a real namespace export fixture without a default", () => {
		const definition = getPluginDefinition(fixture);
		expect(definition.name).toBe("fixture.namespace");
		expect(isPluginDefinition(definition)).toBe(true);
		expect("default" in fixture).toBe(false);
	});

	it("rejects default exports", () => {
		expect(() => getPluginDefinition({ default: { name: "bad", apply: () => undefined } })).toThrow(/default export/);
	});

	it("rejects incomplete definitions", () => {
		expect(isPluginDefinition({ name: "missing-apply" })).toBe(false);
		expect(() => getPluginDefinition({ name: "missing-apply" })).toThrow(/apply function/);
	});

	it("merges layers and applies id-targeted patches deterministically", () => {
		const entries = mergeCompositionLayers([
			{
				name: "base",
				document: {
					entries: [
						{ id: "a", name: "fixture.a" },
						{ id: "b", name: "fixture.b" },
					],
				},
			},
			{
				name: "mode",
				document: {
					patches: [
						{ op: "disable", id: "b" },
						{ op: "insert", after: "a", entry: { id: "c", name: "fixture.c" } },
					],
				},
			},
			{
				name: "user",
				document: {
					patches: [
						{ op: "enable", id: "b" },
						{ op: "move", id: "c", before: "a" },
					],
				},
			},
		]);
		expect(entries.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
		expect(entries[2]?.disabled).toBe(false);
	});

	it("parses JSON/YAML values and rejects command expressions", () => {
		expect(
			parseComposition(
				`entries:\n  - id: one\n    name: fixture.one\n    config:\n      value: \${SAFE_VALUE}\n`,
				"yaml",
				{ SAFE_VALUE: "resolved" },
			).entries?.[0]?.config,
		).toEqual({ value: "resolved" });
		expect(() =>
			parseComposition('{"entries":[{"id":"one","name":"fixture.one","config":{"x":"$(whoami)"}}]}', "json"),
		).toThrow(/forbidden/);
	});

	it("sorts dependencies and rejects missing/cyclic required edges", () => {
		const entries = [
			{ id: "consumer", name: "fixture.consumer", dependsOn: ["provider"] },
			{ id: "provider", name: "fixture.provider" },
		];
		expect(topologicallySortEntries(entries).map((entry) => entry.id)).toEqual(["provider", "consumer"]);
		expect(() => topologicallySortEntries([{ id: "a", name: "a", dependsOn: ["missing"] }])).toThrow(
			/missing dependency/,
		);
		expect(() =>
			topologicallySortEntries([
				{ id: "a", name: "a", dependsOn: ["b"] },
				{ id: "b", name: "b", dependsOn: ["a"] },
			]),
		).toThrow(/cycle/);
	});

	it("loads a fixture plugin package through the real Loader import, keeps disabled entries unimported, and isolates optional failure", async () => {
		const context = createRootContext();
		const fixture = new URL("./fixtures/composition-plugin/plugin.ts", import.meta.url).href;
		const missing = new URL("./fixtures/missing-plugin.ts", import.meta.url).href;
		const loader = createCompositionLoader({
			context,
			entries: [
				{ id: "required", name: fixture },
				{ id: "disabled", name: missing, disabled: true },
				{ id: "optional", name: missing, required: false },
			],
		});
		const inventory = await loader.load();
		expect(inventory.get("required")?.status).toBe("active");
		expect(inventory.get("disabled")?.status).toBe("disabled");
		expect(inventory.get("optional")?.status).toBe("skipped");
		await loader.dispose();
		await context.dispose();
	});
	it("skips project-local entries when the project is untrusted", async () => {
		const context = createRootContext();
		const fixture = new URL("./fixtures/composition-plugin/plugin.ts", import.meta.url).href;
		const loader = createCompositionLoader({
			context,
			projectTrusted: false,
			entries: [{ id: "project", name: fixture, projectLocal: true }],
		});
		expect((await loader.load()).get("project")?.status).toBe("skipped");
		await context.dispose();
	});
	it("reports real import failures with a skipped optional entry", async () => {
		const context = createRootContext();
		const broken = new URL("./fixtures/import-failure.ts", import.meta.url).href;
		const loader = createCompositionLoader({ context, entries: [{ id: "broken", name: broken, required: false }] });
		expect((await loader.load()).get("broken")?.status).toBe("skipped");
		await context.dispose();
	});

	it("blocks required failure and rolls back preceding entries", async () => {
		const context = createRootContext();
		const fixture = new URL("./fixtures/composition-plugin/plugin.ts", import.meta.url).href;
		const loader = createCompositionLoader({
			context,
			entries: [
				{ id: "healthy", name: fixture },
				{ id: "broken", name: fixture, config: { fail: true } },
			],
		});
		await expect(loader.load()).rejects.toThrow(/Required entry broken failed/);
		expect(loader.tree.get("healthy")?.fiber?.status).toBe("disposed");
		expect(loader.tree.get("broken")?.status).toBe("failed");
		await context.dispose();
	});
});

describe("Plugin installation and trust", () => {
	it("persists project trust decisions by canonical path", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-trust-"));
		const store = new ProjectTrustStore(join(root, "trust.json"));
		expect(await store.get(root)).toBeNull();
		await store.set(root, true);
		expect(await store.get(root)).toBe(true);
	});

	it("rolls back an install when registry replacement fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-rollback-"));
		const source = join(root, "source");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "package.json"),
			JSON.stringify({
				name: "rollback",
				version: "1.0.0",
				type: "module",
				exports: { "./plugin": "./index.mjs" },
				diCode: {
					apiVersion: 1,
					plugins: ["./plugin"],
					permissions: { filesystem: "none", network: [], process: [] },
				},
			}),
		);
		await writeFile(
			join(source, "index.mjs"),
			"export const name='rollback'; export const version='1'; export const apply=()=>{};",
		);
		const managedRoot = join(root, "managed");
		const manager = new PluginInstallManager({ managedRoot });
		await manager.installLocal(source);
		await writeFile(
			join(source, "index.mjs"),
			"export const name='rollback-new'; export const version='2'; export const apply=()=>{};",
		);
		const brokenManager = new PluginInstallManager({ managedRoot, registryPath: managedRoot });
		await expect(brokenManager.installLocal(source)).rejects.toThrow();
		expect(await readFile(join(managedRoot, "rollback", "index.mjs"), "utf8")).toContain("rollback");
	});
});
