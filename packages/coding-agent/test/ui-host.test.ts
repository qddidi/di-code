import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import type { PluginModule } from "@di-code/plugin-loader";
import { describe, expect, it } from "vitest";
import { importCompositionModule } from "../src/compositions.ts";
import { runMinimalProfile } from "../src/main.ts";
import { fixtureEvents, lastHost } from "./fixtures/custom-tui.ts";
import { disposedHost } from "./fixtures/failing-custom-tui.ts";

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

function replacementComposition(name: string): string {
	return `patches:\n  - op: replace\n    id: interactive-host\n    entry:\n      id: interactive-host\n      name: ${name}\n      dependsOn: [session-factory, session-store-jsonl, interactive-resources, mcp-config, mcp-client, mcp-tools, interactive-context, mode-interactive]\n`;
}

describe("ui-host public contract", () => {
	it("replaces interactive-host through a composition patch without importing private product modules", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-ui-host-"));
		const agentDir = join(root, "agent");
		const compositionPath = join(root, "custom-tui.yml");
		const fixturePath = join(process.cwd(), "test", "fixtures", "custom-tui.ts");
		const diagnostics: string[] = [];
		const previousProvider = process.env.DI_CODE_PROVIDER;
		const previousModel = process.env.DI_CODE_MODEL;
		try {
			process.env.DI_CODE_PROVIDER = "faux";
			delete process.env.DI_CODE_MODEL;
			await writeFile(
				compositionPath,
				`${replacementComposition("custom-tui-fixture")}  - op: replace\n    id: provider-faux\n    entry:\n      id: provider-faux\n      name: "@di-code/builtins/provider-faux"\n      dependsOn: [provider-registry]\n      config:\n        responses:\n          - type: success\n            content:\n              - type: text\n                text: cancelled\n          - type: success\n            content:\n              - type: text\n                text: retried\n`,
			);
			const code = await runMinimalProfile(["--interactive", "--composition", compositionPath], {
				version: "test",
				allowedRoot: root,
				agentDir,
				stdout: () => undefined,
				stderr: (text) => diagnostics.push(text),
				interactive: { isInteractiveTerminal: true },
				importModule: async (entry) => {
					if (entry === "custom-tui-fixture") return (await import("./fixtures/custom-tui.ts")) as PluginModule;
					if (entry.startsWith("@di-code/builtins/")) {
						const entryName = entry.slice("@di-code/builtins/".length);
						const plugin = [...Object.values(pluginModules), ...additionalBuiltinModules].find(
							(item) => item.name === (entryName === "bootstrap" ? "Bootstrap" : entryName),
						);
						if (!plugin) throw new Error(`Missing builtins fixture entry: ${entry}`);
						return plugin as PluginModule;
					}
					return await importCompositionModule(entry);
				},
			});

			expect(code, diagnostics.join("")).toBe(0);
			expect(fixtureEvents).toEqual(["cancelled", "retried", "switched", "rendered", "exited"]);
			expect(() => lastHost?.session.state()).toThrow("UiHost has been disposed.");
			const source = await readFile(fixturePath, "utf8");
			expect(source).toContain('from "@di-code/coding-agent/ui-host"');
			expect(source).toContain('from "@di-code/tui"');
			expect(source).not.toMatch(/(?:\.\.\/)+src|\/dist\//);
		} finally {
			if (previousProvider === undefined) delete process.env.DI_CODE_PROVIDER;
			else process.env.DI_CODE_PROVIDER = previousProvider;
			if (previousModel === undefined) delete process.env.DI_CODE_MODEL;
			else process.env.DI_CODE_MODEL = previousModel;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("disposes the facade when a custom TUI startup callback fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-ui-host-failure-"));
		const agentDir = join(root, "agent");
		const compositionPath = join(root, "failing-custom-tui.yml");
		const diagnostics: string[] = [];
		const previousProvider = process.env.DI_CODE_PROVIDER;
		try {
			process.env.DI_CODE_PROVIDER = "faux";
			await writeFile(compositionPath, replacementComposition("failing-custom-tui"));
			const code = await runMinimalProfile(["--interactive", "--composition", compositionPath], {
				version: "test",
				allowedRoot: root,
				agentDir,
				stdout: () => undefined,
				stderr: (text) => diagnostics.push(text),
				interactive: { isInteractiveTerminal: true },
				importModule: async (entry) => {
					if (entry === "failing-custom-tui") return (await import("./fixtures/failing-custom-tui.ts")) as PluginModule;
					if (entry.startsWith("@di-code/builtins/")) {
						const entryName = entry.slice("@di-code/builtins/".length);
						const plugin = [...Object.values(pluginModules), ...additionalBuiltinModules].find(
							(item) => item.name === (entryName === "bootstrap" ? "Bootstrap" : entryName),
						);
						if (!plugin) throw new Error(`Missing builtins fixture entry: ${entry}`);
						return plugin as PluginModule;
					}
					return await importCompositionModule(entry);
				},
			});

			expect(code).toBe(1);
			expect(diagnostics.join("")).toContain("custom TUI startup failed");
			expect(() => disposedHost?.session.state()).toThrow("UiHost has been disposed.");
		} finally {
			if (previousProvider === undefined) delete process.env.DI_CODE_PROVIDER;
			else process.env.DI_CODE_PROVIDER = previousProvider;
			await rm(root, { recursive: true, force: true });
		}
	});
});
