import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, loadExtensions } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public extension SDK", () => {
	it("loads the standalone example through the public package entry point", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-sdk-"));
		roots.push(root);
		const example = join(process.cwd(), "examples", "extensions", "hello.mjs");
		const result = await loadExtensions({ cwd: root, projectTrusted: true, paths: [example], mode: "json" });
		expect(result.diagnostics).toEqual([]);
		expect(result.loaded).toEqual([{ path: example }]);
		expect(result.host.listCommands().map((command) => command.name)).toEqual(["hello"]);
		expect(result.host.listTools().map((tool) => tool.name)).toEqual(["project-name"]);
		expect(await result.host.runTool("project-name", "call-1", {})).toEqual([{ type: "text", text: root }]);
	});

	it("adapts loaded extension tools and real AgentSession events for the faux provider", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-sdk-"));
		roots.push(root);
		const extensionPath = join(root, "fixture.mjs");
		const marker = join(root, "agent-end.txt");
		await writeFile(
			extensionPath,
			[
				'import { writeFile } from "node:fs/promises";',
				"export default (api) => {",
				'  api.registerTool({ name: "extension-status", description: "Returns extension status", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async (_id, _parameters, signal, ctx) => [{ type: "text", text: ctx.mode + ":" + ctx.isProjectTrusted() + ":" + (signal?.aborted ?? false) }] });',
				'  api.on("agent_end", async (event, ctx) => { await writeFile(__MARKER__, event.type + ":" + ctx.cwd, "utf8"); });',
				"};",
			]
				.join("\n")
				.replace("__MARKER__", JSON.stringify(marker)),
		);
		const loaded = await loadExtensions({ cwd: root, projectTrusted: true, paths: [extensionPath], mode: "json" });
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "extension-status-call", name: "extension-status", arguments: {} }],
				},
				{ type: "success", content: [{ type: "text", text: "answer" }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
			extensionHost: loaded.host,
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
	});
});
