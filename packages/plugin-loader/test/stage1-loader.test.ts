import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	computePackageIntegrity,
	createCompositionLoader,
	type createExtensionAPI,
	normalizePluginSource,
	PluginTrustStore,
	preflightPluginPackage,
} from "../src/index.ts";

describe("freedom stage 1 loader", () => {
	it("loads default setup(api) through Composition and disposes registrations", async () => {
		const context = createRootContext();
		let called = 0;
		const loader = createCompositionLoader({
			context,
			entries: [{ id: "setup", name: "fixture:setup" }],
			importModule: async () => ({
				default: (api: ReturnType<typeof createExtensionAPI>) => {
					called += 1;
					api.registerCommand({ name: "hello", description: "", run: async () => ({}) });
				},
			}),
		});
		expect((await loader.load()).get("setup")?.status).toBe("active");
		expect(called).toBe(1);
		expect(loader.extensionApis.get("setup")?.commands).toHaveLength(1);
		await loader.dispose();
		expect(loader.extensionApis.size).toBe(0);
		await context.dispose();
	});

	it("runs preflight before import and rejects untrusted integrity", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-stage1-loader-"));
		const trustPath = join(tmpdir(), `di-code-stage1-trust-${Date.now()}.json`);
		try {
			const packageJson = {
				name: "example",
				version: "1.0.0",
				type: "module",
				exports: { "./plugin": "./index.mjs" },
				diCode: { apiVersion: 1, plugins: ["./plugin"], permissions: { filesystem: "none", network: [], process: [] } },
			};
			await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
			await writeFile(join(root, "index.mjs"), "export default () => {};\n");
			const integrity = await computePackageIntegrity(root);
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ ...packageJson, diCode: { ...packageJson.diCode, packageIntegrity: integrity } }),
			);
			const store = new PluginTrustStore(trustPath);
			await expect(preflightPluginPackage(root, { trustStore: store })).rejects.toThrow(/trust confirmation/);
			await store.trust({
				pluginId: "example",
				source: normalizePluginSource(await realpath(root)),
				resolvedVersion: "1.0.0",
				packageIntegrity: await computePackageIntegrity(root),
			});
			await expect(preflightPluginPackage(root, { trustStore: store })).resolves.toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(trustPath, { force: true });
		}
	});
});
