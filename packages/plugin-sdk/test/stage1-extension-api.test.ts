import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computePackageIntegrity,
	computeWebBundleIntegrity,
	createExtensionAPI,
	normalizePluginSource,
	PluginTrustStore,
} from "../src/index.ts";

describe("freedom stage 1 ExtensionAPI", () => {
	it("registers contributions, rejects duplicates, and disposes idempotently", async () => {
		const api = createExtensionAPI("example");
		const dispose = api.registerCommand({ name: "hello", description: "hello", run: async () => ({}) });
		api.registerTool({ name: "echo", description: "echo", schema: {}, execute: async () => ({}) });
		expect(() => api.registerCommand({ name: "hello", description: "again", run: async () => ({}) })).toThrow(
			/Duplicate/,
		);
		dispose();
		dispose();
		expect(api.commands).toHaveLength(0);
		await api.dispose();
		await api.dispose();
		expect(api.ctx.signal.aborted).toBe(true);
	});

	it("isolates throwing event handlers", async () => {
		const api = createExtensionAPI("events");
		const calls: string[] = [];
		api.on("event", () => {
			throw new Error("handler failed");
		});
		api.on("event", () => {
			calls.push("ok");
		});
		await api.emit("event", { value: 1 });
		expect(calls).toEqual(["ok"]);
		await api.dispose();
	});

	it("computes independent package and web digests and persists revocation", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-stage1-"));
		try {
			await writeFile(join(root, "package.json"), JSON.stringify({ name: "example", packageIntegrity: "ignored" }));
			await writeFile(join(root, "index.js"), "export default () => {};\n");
			const integrity = await computePackageIntegrity(root);
			expect(integrity).toMatch(/^sha256-/);
			expect(await computeWebBundleIntegrity(join(root, "index.js"))).toMatch(/^sha256-/);
			expect(normalizePluginSource(root)).toMatch(/^file:/);
			const store = new PluginTrustStore(join(root, "trust.json"));
			await store.trust({
				pluginId: "example",
				source: "file:///example",
				resolvedVersion: "1.0.0",
				packageIntegrity: integrity,
			});
			expect(await store.find("example", "file:///example", "1.0.0", integrity)).toBeDefined();
			await store.revoke("example");
			expect(await store.find("example", "file:///example", "1.0.0", integrity)).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
