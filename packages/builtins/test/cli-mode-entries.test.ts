import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	bootstrap,
	cliParser,
	commandCore,
	commandModel,
	commandRegistryKey,
	commandSession,
	compactionBasic,
	compactionRegistryKey,
	compactionToolResult,
	createBuiltinCommandRegistry,
	diagnosticSinkRegistryKey,
	diagnostics,
	diagnosticsKey,
	hostCommandRegistryKey,
	modeJson,
	modeRegistryKey,
	modeRpc,
	outputJson,
	pluginInvariants,
	pluginProfiler,
	pluginTestRuntime,
	rendererRegistryKey,
	sessionMigrationRegistryKey,
	sessionMigrations,
	sessionStoreJsonl,
	sessionStoreRegistryKey,
	testRuntimeKey,
	theme,
	themeRegistryKey,
} from "../src/index.ts";

describe("CLI and output composition", () => {
	it("keeps command contributions owner-scoped and generates registry help", async () => {
		const context = createRootContext({ id: "commands" });
		try {
			await context.plugin(commandCore, undefined);
			await context.plugin(commandSession, undefined);
			await context.plugin(commandModel, undefined);
			const registry = context.require(commandRegistryKey);
			expect(registry.list().map((command) => command.name)).toEqual(["login", "logout", "model", "session", "tree"]);
			expect(registry.help("en")).toContain("/model");
			await context.dispose();
			expect(context.get(commandRegistryKey)).toBeUndefined();
		} finally {
			await context.dispose();
		}
	});

	it("registers JSON mode and renderer through the same composition context", async () => {
		const context = createRootContext({ id: "modes", mode: "json" });
		try {
			await context.plugin(bootstrap, undefined);
			await context.plugin(commandCore, undefined);
			await context.plugin(cliParser, undefined);
			await context.plugin(modeJson, undefined);
			await context.plugin(outputJson, undefined);
			await context.plugin(theme, undefined);
			expect(context.require(hostCommandRegistryKey).list()).toContain("json");
			expect(
				context
					.require(modeRegistryKey)
					.list()
					.map((mode) => mode.name),
			).toEqual(["json"]);
			expect(context.require(rendererRegistryKey).find("json")?.render({ type: "agent_end" })).toContain('"version":2');
			expect(
				context
					.require(themeRegistryKey)
					.list()
					.map((entry) => entry.name),
			).toEqual(["dark", "light"]);
		} finally {
			await context.dispose();
		}
	});

	it("provides a standalone command registry for legacy interactive hosts", async () => {
		const registry = createBuiltinCommandRegistry();
		const calls: string[] = [];
		await registry.execute("clear", { args: "", host: { runCommand: (name: string) => calls.push(name) } });
		expect(calls).toEqual(["clear"]);
	});

	it("exposes an owner-scoped SessionStore registry for replaceable persistence entries", async () => {
		const context = createRootContext({ id: "session-stores" });
		try {
			await context.plugin(sessionStoreJsonl, undefined);
			const registry = context.require(sessionStoreRegistryKey);
			const disposer = registry.register("memory", {
				create: () => ({ kind: "memory" }),
				open: () => ({ kind: "memory" }),
			});
			expect(registry.get("memory")?.create({})).toEqual({ kind: "memory" });
			disposer();
			expect(registry.get("memory")).toBeUndefined();
		} finally {
			await context.dispose();
		}
	});

	it("registers migration, compaction, RPC mode, diagnostics, and test-runtime entries independently", async () => {
		const context = createRootContext({ id: "remaining-entries" });
		try {
			await context.plugin(commandCore, undefined);
			await context.plugin(modeRpc, undefined);
			expect(
				context
					.require(modeRegistryKey)
					.list()
					.map((entry) => entry.name),
			).toEqual(["rpc"]);
			await context.plugin(compactionBasic, undefined);
			await context.plugin(compactionToolResult, undefined);
			expect(
				await context.require(compactionRegistryKey).snapshot()[0]?.compact({ text: "hello", maxChars: 3 }),
			).toMatchObject({
				text: "hel...",
			});
			await context.plugin(sessionMigrations, undefined);
			expect(context.require(sessionMigrationRegistryKey).snapshot()).toEqual(["session-v2-plugin-records"]);
			await context.plugin(diagnostics, undefined);
			const received: unknown[] = [];
			const sinkDispose = context.require(diagnosticSinkRegistryKey).register("test", (value) => received.push(value));
			context.require(diagnosticsKey).report({ type: "plugin_status", status: "active" });
			expect(received).toHaveLength(1);
			sinkDispose();
			await context.plugin(pluginProfiler, undefined);
			await context.plugin(pluginInvariants, undefined);
			await context.plugin(pluginTestRuntime, undefined);
			context.require(testRuntimeKey).reset();
			expect(context.require(testRuntimeKey).snapshot()).toEqual({ events: 0 });
		} finally {
			await context.dispose();
		}
	});

	it("atomically upgrades legacy plugin-record schema zero and transforms tool results", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-builtins-migration-"));
		const filePath = join(root, "session.jsonl");
		try {
			await writeFile(
				filePath,
				`${JSON.stringify({ type: "session", version: 2, id: "s", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n${JSON.stringify({ type: "plugin", version: 2, id: "p", parentId: "s", timestamp: "2026-01-01T00:00:00.000Z", pluginId: "@di-code/session", pluginVersion: "1", schemaVersion: 0, data: { keep: true } })}\n${JSON.stringify({ type: "plugin", version: 2, id: "u", parentId: "p", timestamp: "2026-01-01T00:00:00.000Z", pluginId: "third-party", pluginVersion: "1", schemaVersion: 0, data: { opaque: true } })}\n`,
				"utf8",
			);
			const context = createRootContext({ id: "migration", mode: "test" });
			try {
				await context.plugin(sessionMigrations, undefined);
				await context.require(sessionMigrationRegistryKey).migrate(filePath);
				const migratedLines = (await readFile(filePath, "utf8")).split("\n");
				expect((JSON.parse(migratedLines[1] ?? "") as { schemaVersion: number }).schemaVersion).toBe(1);
				expect((JSON.parse(migratedLines[2] ?? "") as { schemaVersion: number }).schemaVersion).toBe(0);
			} finally {
				await context.dispose();
			}

			const compactionContext = createRootContext({ id: "tool-result-compaction", mode: "test" });
			try {
				await compactionContext.plugin(compactionBasic, undefined);
				await compactionContext.plugin(compactionToolResult, undefined);
				const result = await compactionContext
					.require(compactionRegistryKey)
					.snapshot()[0]
					?.compact({
						messages: [
							{
								role: "tool_result",
								toolCallId: "call",
								toolName: "read",
								content: [{ type: "text", text: "abcdef" }],
								isError: false,
								timestamp: 0,
							},
						],
						maxChars: 3,
					});
				expect(result).toMatchObject({ messages: [{ content: [{ type: "text", text: "abc..." }] }] });
			} finally {
				await compactionContext.dispose();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
