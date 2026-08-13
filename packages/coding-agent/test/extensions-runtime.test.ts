import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost, loadExtensions, ProjectTrustManager } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createHost(projectTrusted = true): ExtensionHost {
	return new ExtensionHost({ cwd: "D:/project", mode: "json", projectTrusted });
}

describe("ExtensionHost", () => {
	it("persists project trust decisions across manager instances", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-trust-"));
		roots.push(root);
		const project = join(root, "project", "nested");
		const trustPath = join(root, "trust", "projects.json");
		const first = new ProjectTrustManager(trustPath);
		expect(await first.get(project)).toBeNull();
		await first.set(project, true);
		const second = new ProjectTrustManager(trustPath);
		expect(await second.get(project)).toBe(true);
		expect(await second.get(join(root, "project", "nested", "child"))).toBe(true);
		await second.set(project, null);
		expect(await new ProjectTrustManager(trustPath).get(project)).toBeNull();
		const stored = JSON.parse(await readFile(trustPath, "utf8")) as { version: number };
		expect(stored.version).toBe(1);
	});

	it("loads project extensions from persisted trust when no override is supplied", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-trust-"));
		roots.push(root);
		const projectDir = join(root, ".di-code", "extensions");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(projectDir, "project.mjs"),
			`export default (api) => api.registerCommand({ name: "persistent", description: "p", handler: async () => {} });`,
		);
		const trustManager = new ProjectTrustManager(join(root, "trust.json"));
		await trustManager.set(root, true);
		const result = await loadExtensions({ cwd: root, trustManager });
		expect(result.loaded).toHaveLength(1);
		expect(result.host.listCommands().map((command) => command.name)).toEqual(["persistent"]);
	});

	it("registers commands, validates tools, and dispatches typed events", async () => {
		const host = createHost();
		const observed: string[] = [];
		await host.registerExtension("inline:test", (api) => {
			api.registerCommand({
				name: "hello",
				description: "Hello",
				handler: async (ctx) => {
					observed.push(ctx.args);
				},
			});
			const schema = Type.Object({ path: Type.String() });
			api.registerTool({
				name: "read-only",
				description: "Read",
				parameters: schema,
				execute: async (_id, args) => [{ type: "text", text: args.path }],
			});
			api.on("agent_end", (event) => {
				observed.push(`event:${event.type}`);
			});
		});

		await host.runCommand("hello", "world");
		const result = await host.runTool("read-only", "call-1", { path: "README.md" });
		await host.emit({ type: "agent_end", messages: [] });
		await expect(host.runTool("read-only", "call-2", { path: 1 })).rejects.toThrow("Tool arguments invalid");
		expect(result).toEqual([{ type: "text", text: "README.md" }]);
		expect(observed).toEqual(["world", "event:agent_end"]);
	});

	it("rolls back an extension when a command or tool conflicts", async () => {
		const host = createHost();
		await host.registerExtension("inline:first", (api) => {
			api.registerCommand({ name: "deploy", description: "First", handler: async () => {} });
		});
		await expect(
			host.registerExtension("inline:second", (api) => {
				api.registerCommand({ name: "deploy", description: "Second", handler: async () => {} });
			}),
		).rejects.toThrow('Extension command conflict: "deploy"');
		expect(host.listCommands().map((command) => command.name)).toEqual(["deploy"]);

		const toolSchema = Type.Object({});
		await host.registerExtension("inline:tool-first", (api) => {
			api.registerTool({
				name: "inspect",
				description: "First",
				parameters: toolSchema,
				execute: async () => [{ type: "text", text: "first" }],
			});
		});
		await expect(
			host.registerExtension("inline:tool-second", (api) => {
				api.registerTool({
					name: "inspect",
					description: "Second",
					parameters: toolSchema,
					execute: async () => [{ type: "text", text: "second" }],
				});
			}),
		).rejects.toThrow('Extension tool conflict: "inspect"');
		expect(host.listTools().map((tool) => tool.name)).toEqual(["inspect"]);
	});

	it("skips project extensions until trust is granted", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-ext-"));
		roots.push(root);
		const projectDir = join(root, ".di-code", "extensions");
		await mkdir(projectDir, { recursive: true });
		const marker = join(root, "loaded.txt");
		await writeFile(
			join(projectDir, "project.mjs"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default (api) => api.registerCommand({ name: "project", description: "p", handler: async () => {} });`,
		);

		const skipped = await loadExtensions({ cwd: root, projectTrusted: false });
		expect(skipped.loaded).toHaveLength(0);
		expect(skipped.diagnostics[0]?.message).toBe("Project extension skipped because project trust is not granted");
		await expect(import("node:fs/promises").then(({ access }) => access(marker))).rejects.toThrow();

		const loaded = await loadExtensions({ cwd: root, projectTrusted: true });
		expect(loaded.loaded.map((extension) => extension.path)).toHaveLength(1);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("reports invalid exports and factory failures without stopping other extensions", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-ext-"));
		roots.push(root);
		const good = join(root, "good.mjs");
		const badExport = join(root, "bad-export.mjs");
		const badFactory = join(root, "bad-factory.mjs");
		await writeFile(
			good,
			`export default (api) => api.registerCommand({ name: "good", description: "g", handler: async () => {} });`,
		);
		await writeFile(badExport, `export const value = 1;`);
		await writeFile(badFactory, `export default async () => { throw new Error("factory exploded"); };`);

		const result = await loadExtensions({ cwd: root, projectTrusted: true, paths: [good, badExport, badFactory] });
		expect(result.loaded.map((extension) => extension.path)).toEqual([good]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.stage)).toEqual(["factory", "factory"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			"Extension module must export a default factory function",
			"Failed to load extension: factory exploded",
		]);
	});

	it("reports dynamic import failures with an import stage", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-ext-"));
		roots.push(root);
		const missing = join(root, "missing.mjs");
		const result = await loadExtensions({ cwd: root, projectTrusted: true, paths: [missing] });
		expect(result.loaded).toEqual([]);
		expect(result.diagnostics[0]?.stage).toBe("import");
		expect(result.diagnostics[0]?.message).toContain("Failed to import extension:");
	});
});
