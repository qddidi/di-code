import { fileURLToPath } from "node:url";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	createCompositionLoader,
	getPluginDefinition,
	isPluginDefinition,
	mergeCompositionLayers,
	parseComposition,
	parsePluginManifest,
	readPackagePluginManifest,
	resolvePluginEntry,
	topologicallySortEntries,
} from "../src/index.ts";
import * as fixture from "./fixtures/namespace-plugin.ts";

describe("namespace plugin loader contract", () => {
	it("validates package manifests and rejects unsafe declarations", () => {
		const manifest = parsePluginManifest({
			apiVersion: 1,
			id: "fixture-plugin",
			name: "Fixture Plugin",
			version: "1.0.0",
			entry: "./plugin.ts",
			permissions: { filesystem: "none", network: [], process: [] },
		});
		expect(manifest.id).toBe("fixture-plugin");
		expect(() => parsePluginManifest({ ...manifest, entry: "../escape.ts" })).toThrow(/relative/);
		expect(() =>
			parsePluginManifest({
				...manifest,
				permissions: { filesystem: "none", network: ["http://example.com"], process: [] },
			}),
		).toThrow(/HTTPS/);
	});

	it("reads package diCode metadata and keeps entry inside the package root", async () => {
		const root = new URL("./fixtures/composition-plugin/", import.meta.url);
		const rootPath = fileURLToPath(root);
		const manifest = await readPackagePluginManifest(rootPath);
		expect(manifest.id).toBe("composition-plugin");
		expect(await resolvePluginEntry(rootPath, manifest.entry)).toMatch(/plugin\.ts$/);
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
