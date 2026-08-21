import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, loadPlugins } from "../src/index.ts";
import { CodingAgentPluginHost } from "../src/plugins/runtime-host.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public plugin SDK", () => {
	it("loads the standalone plugin through the public package entry point", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-sdk-"));
		roots.push(root);
		const pluginRoot = join(process.cwd(), "examples", "plugins");
		const result = await loadPlugins({ cwd: root, projectTrusted: true, explicitPaths: [pluginRoot], mode: "json" });
		expect(result.diagnostics).toEqual([]);
		expect(result.loaded.map((plugin) => plugin.manifest.id)).toEqual(["hello"]);
		expect(result.runtimeHost.listCommands().map((command) => command.name)).toEqual(["hello"]);
		expect(result.runtimeHost.listTools().map((tool) => tool.name)).toEqual(["hello__project-name"]);
	});

	it("adapts loaded plugin tools and real AgentSession events for the faux provider", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-sdk-"));
		roots.push(root);
		const marker = join(root, "agent-end.txt");
		const loaded = new CodingAgentPluginHost({ cwd: root, mode: "json", projectTrusted: true });
		await loaded.load("plugin-status", (api) => {
			api.registerTool({
				name: "plugin-status__status",
				description: "Returns plugin status",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async () => [{ type: "text", text: "json:true:false" }],
			});
			api.on("agent_end", async () => {
				await writeFile(marker, `agent_end:${root}`, "utf8");
			});
		});
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "plugin-status-call", name: "plugin-status__status", arguments: {} }],
				},
				{ type: "success", content: [{ type: "text", text: "answer" }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
			runtimePluginHost: loaded,
		});
		await session.prompt("hello");
		expect(session.transcript).toContainEqual(
			expect.objectContaining({
				role: "tool_result",
				content: [{ type: "text", text: "json:true:false" }],
			}),
		);
		expect(await import("node:fs/promises").then(({ readFile }) => readFile(marker, "utf8"))).toBe(`agent_end:${root}`);
		expect(session.transcript.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		await loaded.dispose();
	});
});
