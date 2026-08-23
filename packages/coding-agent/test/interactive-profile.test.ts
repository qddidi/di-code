import { mkdtemp, rm } from "node:fs/promises";
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
import { SessionManager } from "../src/core/session/session-manager.ts";
import { workspaceStorageKey } from "../src/core/user-data.ts";
import { runMinimalProfile } from "../src/main.ts";

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

describe("interactive composition profile", () => {
	it("starts through the mode registry with new and persisted session choices", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-interactive-profile-"));
		const agentDir = join(root, "agent");
		const sessionDirectory = join(agentDir, "sessions", workspaceStorageKey(root));
		const previousProvider = process.env.DI_CODE_PROVIDER;
		const previousModel = process.env.DI_CODE_MODEL;
		const diagnostics: string[] = [];
		try {
			process.env.DI_CODE_PROVIDER = "faux";
			delete process.env.DI_CODE_MODEL;
			await SessionManager.create({ filePath: join(sessionDirectory, "history.jsonl"), cwd: root });
			const code = await runMinimalProfile(["--interactive"], {
				version: "test",
				allowedRoot: root,
				agentDir,
				stdout: () => undefined,
				stderr: (text) => diagnostics.push(text),
				interactive: {
					isInteractiveTerminal: true,
					startInteractiveMode: (options) => {
						expect(options.providerOnboarding?.agentDir).toBe(agentDir);
						expect(options.providerOnboarding?.configuration).toBeDefined();
						expect(options.commandRegistry.list().map((command) => command.name)).not.toContain("plugin");
						const choices = options.context.sessionChoices();
						expect(choices).toEqual(
							expect.arrayContaining([
								expect.objectContaining({ id: "new-session" }),
								expect.objectContaining({ id: "history" }),
							]),
						);
						options.onExit();
						return 0;
					},
				},
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
			});

			expect(code, diagnostics.join("")).toBe(0);
			expect(diagnostics).toEqual([]);
		} finally {
			if (previousProvider === undefined) delete process.env.DI_CODE_PROVIDER;
			else process.env.DI_CODE_PROVIDER = previousProvider;
			if (previousModel === undefined) delete process.env.DI_CODE_MODEL;
			else process.env.DI_CODE_MODEL = previousModel;
			await rm(root, { recursive: true, force: true });
		}
	});
});
