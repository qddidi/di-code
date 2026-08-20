import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { CodingAgentPluginHost } from "../src/plugins/runtime-host.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodingAgentPluginHost", () => {
	it("adapts commands, JSON projections, and idempotent disposal", async () => {
		const host = new CodingAgentPluginHost({ cwd: process.cwd(), mode: "json", projectTrusted: true });
		const notifications: string[] = [];
		let eventSeen = false;
		await host.load("sample", (api) => {
			api.registerCommand({ name: "sample", description: "sample", handler: ({ notify }) => notify("ok") });
			api.registerSessionProjection({ id: "state", project: (value) => ({ value }) });
			api.on("session_start", () => {
				eventSeen = true;
			});
		});
		await host.runCommand("sample", "", undefined, undefined, (message) => notifications.push(message));
		await host.emit({ type: "session_start", cwd: process.cwd() });
		expect(host.listCommands().map((command) => command.name)).toEqual(["sample"]);
		expect(await host.projectSession("v")).toEqual({ state: { value: "v" } });
		expect(eventSeen).toBe(true);
		await host.dispose();
		await host.dispose();
		expect(notifications).toEqual(["ok"]);
	});
});

describe("runtime plugin loading", () => {
	it("feeds plugin prompt, tools, and middleware into AgentSession request snapshots", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-runtime-plugin-"));
		roots.push(root);
		const pluginRoot = join(root, ".di-code", "plugins", "runtime");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "runtime",
				name: "runtime",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			`export default (api) => {
			api.registerPromptSection({ id: "runtime", order: 1, render: () => "runtime prompt" });
			api.registerTool({ name: "runtime__status", description: "status", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => [{ type: "text", text: "runtime tool" }] });
			api.useToolMiddleware(async (execution, next) => next(execution));
		};`,
		);
		const loaded = await loadPlugins({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });
		if (loaded.runtimeHost.listTools().length === 0) throw new Error(JSON.stringify(loaded.diagnostics));
		expect(loaded.runtimeHost.listTools().map((tool) => tool.name)).toEqual(["runtime__status"]);
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "done" }] }] });
		let prompt: string | undefined;
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				context: import("@di-code/ai").Context,
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				prompt = context.systemPrompt;
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({
			allowedRoot: root,
			provider,
			model: faux.model,
			runtimePluginHost: loaded.runtimeHost,
		});
		await session.prompt("hello");
		expect(prompt).toContain("runtime prompt");
		await loaded.runtimeHost.dispose();
	});
});
