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

	it("connects the host to AgentSession events with the faux provider", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-sdk-"));
		roots.push(root);
		const extensionPath = join(root, "fixture.mjs");
		await writeFile(
			extensionPath,
			`export default (api) => api.on("agent_end", (_event, ctx) => { if (!ctx.isProjectTrusted()) throw new Error("trust missing"); });`,
		);
		const loaded = await loadExtensions({ cwd: root, projectTrusted: true, paths: [extensionPath] });
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
		const events: string[] = [];
		const unsubscribe = session.subscribeSession(async (event) => {
			events.push(event.type);
			if (event.type === "compaction_start" || event.type === "compaction_end" || event.type === "usage_update") return;
			await loaded.host.emit(event);
		});
		await session.prompt("hello");
		unsubscribe();
		expect(events).toContain("agent_end");
		expect(session.transcript.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
