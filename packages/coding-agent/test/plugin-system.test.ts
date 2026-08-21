import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodingAgentPluginHost,
	loadPlugins,
	PluginManager,
	parsePluginManifest,
	readPackagePluginManifest,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function plugin(root: string, id: string, entry: string, source: string): Promise<string> {
	const directory = join(root, ".di-code", "plugins", id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "plugin.json"),
		JSON.stringify({
			apiVersion: 1,
			id,
			name: id,
			version: "1.0.0",
			entry,
			permissions: { filesystem: "none", network: [], process: [] },
		}),
	);
	await writeFile(join(directory, entry), source);
	return directory;
}

describe("plugin manifests and loader", () => {
	it("accepts published package metadata only at the compatible SDK version", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-package-"));
		roots.push(root);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "@acme/published",
				version: "1.0.0",
				diCode: { apiVersion: 1, plugins: ["./dist/index.js"] },
			}),
		);
		const manifest = await readPackagePluginManifest(root);
		expect(manifest.id).toBe("published");
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "published", version: "1.0.0", diCode: { apiVersion: 2, plugins: ["./dist/index.js"] } }),
		);
		await expect(readPackagePluginManifest(root)).rejects.toThrow("API version");
	});

	it("loads a published JavaScript package entry without requiring internal imports", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-package-load-"));
		roots.push(root);
		const directory = join(root, ".di-code", "plugins", "published");
		await mkdir(join(directory, "dist"), { recursive: true });
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({
				name: "@acme/published",
				version: "1.0.0",
				diCode: { apiVersion: 1, plugins: ["./dist/index.js"] },
			}),
		);
		await writeFile(
			join(directory, "dist", "index.js"),
			"export default (api) => api.registerCommand({ name: 'published', description: 'published', handler: async () => {} });",
		);
		const result = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });
		expect(result.loaded.map((entry) => entry.manifest.id)).toEqual(["published"]);
		expect(result.runtimeHost.listCommands().map((command) => command.name)).toEqual(["published"]);
	});
	it("invokes plugin factories only with the runtime API", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-runtime-loader-"));
		roots.push(root);
		await plugin(
			root,
			"runtime-only",
			"index.mjs",
			"export default (api) => { if (!(\"registerSessionProjection\" in api)) throw new Error(\"legacy API\"); api.registerCommand({ name: 'runtime-only', description: 'runtime-only', handler: async () => {} }); };",
		);

		const result = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });

		expect(result.loaded.map((entry) => entry.manifest.id)).toEqual(["runtime-only"]);
		expect(result.diagnostics).toEqual([]);
		expect(result.runtimeHost.listCommands().map((command) => command.name)).toEqual(["runtime-only"]);
	});
	it("loads explicit entry files directly, including outside plugin roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-explicit-plugin-"));
		roots.push(root);
		const entry = join(root, "fixture.mjs");
		await writeFile(
			entry,
			"export default (api) => api.registerCommand({ name: 'explicit', description: 'explicit', handler: async () => {} });",
		);

		const result = await loadPlugins({
			cwd: root,
			agentDir: join(root, "agent"),
			projectTrusted: false,
			explicitPaths: [entry],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.loaded).toHaveLength(1);
		expect(result.runtimeHost.listCommands().map((command) => command.name)).toEqual(["explicit"]);
	});
	it("loads an explicit plugin root without requiring global enablement", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-explicit-root-"));
		roots.push(root);
		const pluginRoot = join(root, "external-plugin");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "external",
				name: "external",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			"export default (api) => api.registerCommand({ name: 'external', description: 'external', handler: async () => {} });",
		);

		const result = await loadPlugins({
			cwd: root,
			agentDir: join(root, "agent"),
			projectTrusted: false,
			explicitPaths: [pluginRoot],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.runtimeHost.listCommands().map((command) => command.name)).toEqual(["external"]);
	});
	it("rejects malformed IDs and unsafe permission declarations", () => {
		expect(() =>
			parsePluginManifest({
				apiVersion: 1,
				id: "Upper",
				name: "p",
				version: "1",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		).toThrow("id must use");
		expect(() =>
			parsePluginManifest({
				apiVersion: 1,
				id: "safe",
				name: "p",
				version: "1",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: ["http://example.test"], process: [] },
			}),
		).toThrow("HTTPS");
	});

	it("rejects a plugin tool outside its declared namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-contract-"));
		roots.push(root);
		await plugin(
			root,
			"contract",
			"index.mjs",
			"export default (api) => api.registerTool({ name: 'status', description: 'status', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => [] });",
		);
		const result = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });
		expect(result.loaded).toEqual([]);
		expect(result.diagnostics[0]?.message).toContain("Plugin tool namespace conflict");
	});

	it("loads trusted manifest TypeScript plugins and skips them before trust", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-"));
		roots.push(root);
		await plugin(
			root,
			"typed",
			"index.ts",
			"export default (api: any) => api.registerCommand({ name: 'typed', description: 'typed', handler: async () => {} });",
		);
		const skipped = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: false });
		expect(skipped.loaded).toEqual([]);
		const loaded = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.runtimeHost.listCommands().map((command) => command.name)).toEqual(["typed"]);
	});

	it("filters discovered plugins by the resolved profile plugin IDs", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-profile-plugins-"));
		roots.push(root);
		await plugin(
			root,
			"allowed",
			"index.mjs",
			"export default (api) => api.registerCommand({ name: 'allowed', description: 'allowed', handler: async () => {} });",
		);
		await plugin(
			root,
			"blocked",
			"index.mjs",
			"export default (api) => api.registerCommand({ name: 'blocked', description: 'blocked', handler: async () => {} });",
		);
		const result = await loadPlugins({
			cwd: root,
			agentDir: join(root, "agent"),
			projectTrusted: true,
			pluginIds: ["allowed"],
		});
		expect(result.loaded.map((entry) => entry.manifest.id)).toEqual(["allowed"]);
		expect(result.runtimeHost.listCommands().map((command) => command.name)).toEqual(["allowed"]);
	});

	it("reports loading, success, and import failures without changing plugin isolation", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-status-"));
		roots.push(root);
		await plugin(
			root,
			"healthy",
			"index.mjs",
			"export default (api) => api.registerCommand({ name: 'healthy', description: 'healthy', handler: async () => {} });",
		);
		await plugin(root, "broken", "index.mjs", "export default () => { throw new Error('plugin failed'); };");
		const statuses: unknown[] = [];

		const result = await loadPlugins({
			cwd: root,
			agentDir: join(root, "agent"),
			projectTrusted: true,
			onPluginLoadStatus: (status) => statuses.push(status),
		});

		expect(result.loaded.map((entry) => entry.manifest.id)).toEqual(["healthy"]);
		expect(statuses).toContainEqual({ state: "loading", pluginId: "healthy" });
		expect(statuses).toContainEqual({ state: "loaded", pluginId: "healthy", tools: 0, commands: 1 });
		expect(statuses).toContainEqual({ state: "loading", pluginId: "broken" });
		expect(statuses).toContainEqual(expect.objectContaining({ state: "failed", pluginId: "broken", stage: "import" }));
	});

	it("rejects entries that escape a plugin root without importing them", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-"));
		roots.push(root);
		const outside = join(root, "outside.mjs");
		await writeFile(outside, "throw new Error('must not import')");
		const directory = await plugin(root, "escape", "../outside.mjs", "");
		await rm(join(directory, "../outside.mjs"), { force: true }).catch(() => {});
		const result = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });
		expect(result.loaded).toEqual([]);
		expect(result.diagnostics[0]?.stage).toBe("import");
		expect(result.diagnostics[0]?.message).toContain("stay inside");
	});

	it("isolates handler errors and redacts token-like diagnostic values", async () => {
		const host = new CodingAgentPluginHost({ cwd: "D:/plugin", mode: "json", projectTrusted: true });
		await host.load("test", (api) => {
			api.on("agent_end", () => {
				throw new Error("token=private-value");
			});
		});
		await host.emit({ type: "agent_end", messages: [] });
		expect(host.diagnostics).toEqual([
			expect.objectContaining({ stage: "handler", message: expect.stringContaining("token=[redacted]") }),
		]);
	});
});

describe("PluginManager", () => {
	it("persists local installation enable state and only removes managed destinations", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-manager-"));
		roots.push(root);
		const source = join(root, "source");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "local",
				name: "local",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(join(source, "index.mjs"), "export default () => {};");
		const manager = new PluginManager({
			agentDir: join(root, "agent"),
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		const installed = await manager.installLocal(source);
		expect(installed.enabled).toBe(true);
		await manager.disable("local");
		expect((await manager.list())[0]).toMatchObject({ id: "local", enabled: false });
		await manager.remove("local");
		expect(await manager.list()).toEqual([]);
		const registry = JSON.parse(await readFile(join(root, "agent", "plugins", "registry.json"), "utf8"));
		expect(registry.plugins).toEqual({});
	});
});
