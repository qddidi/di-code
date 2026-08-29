import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import {
	agentSession,
	compactionBasic,
	compactionToolResult,
	contextBudget,
	networkCapability,
	processCapability,
	providerRegistry,
	resourceLoader,
	sessionMigrations,
	sessionStoreJsonl,
	skills,
	systemPrompt,
	type ToolApprovalCapability,
	toolApproval,
	toolOutput,
	toolPolicy,
	toolRead,
	toolRegistry,
	usageMeter,
	workspace,
	workspaceCapabilityKey,
} from "@di-code/builtins";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import * as interactiveResources from "../src/interactive-resources-entry.ts";
import { mcpClient, mcpConfig, mcpTools, mcpTransport } from "../src/mcp/entries.ts";
import { installAgentSessionFactory } from "../src/runtime/session-factory.ts";
import { createSessionHost, HostManager, SessionHostError } from "../src/runtime/session-host.ts";
import * as productSessionStoreJsonl from "../src/session-store-jsonl-entry.ts";

async function setup(
	root: string,
	agentDir: string,
	faux: ReturnType<typeof createFauxProvider>,
	compaction?: import("../src/core/session.ts").AgentSessionCompactionOptions,
	approvalCapability?: ToolApprovalCapability,
) {
	const context = createRootContext({ id: "session-host-test", mode: "test", trustedProject: true });
	for (const definition of [providerRegistry, toolRegistry]) await context.plugin(definition, undefined);
	await context.plugin(workspace, { allowedRoot: root });
	for (const definition of [
		processCapability,
		networkCapability,
		toolApproval,
		toolPolicy,
		toolOutput,
		toolRead,
		contextBudget,
		compactionBasic,
		compactionToolResult,
		systemPrompt,
		resourceLoader,
		skills,
		usageMeter,
		agentSession,
		sessionStoreJsonl,
		sessionMigrations,
	])
		await context.plugin(definition, undefined);
	await context.plugin(productSessionStoreJsonl, undefined);
	await context.plugin(interactiveResources, undefined);
	await context.plugin(mcpConfig, undefined);
	await context.plugin(mcpTransport, undefined);
	await context.plugin(mcpClient, undefined);
	await context.plugin(mcpTools, undefined);
	const removeFactory = installAgentSessionFactory(context);
	const host = await createSessionHost(context, {
		cwd: root,
		agentDir,
		provider: faux.provider,
		model: faux.model,
		compaction,
		toolApproval: approvalCapability,
	});
	return { context, host, removeFactory };
}

describe("SessionHost", () => {
	it("persists Session policy mode and restores it from the event log", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-policy-root-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-policy-agent-"));
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }] });
		const { context, host, removeFactory } = await setup(root, agentDir, faux);
		try {
			const session = await host.createSession();
			expect(host.toolPolicy()).toMatchObject({ mode: "normal", revision: 0, sessionId: session.id });
			await host.setToolPolicyMode("read_only");
			expect(host.toolPolicy()).toMatchObject({ mode: "read_only", revision: 1 });
			const inspected = await host.inspectSession(session.id);
			expect(inspected.events?.at(-1)?.payload).toEqual({ mode: "read_only" });
			await host.closeSession();
			await host.openSession(session.id);
			expect(host.toolPolicy()).toMatchObject({ mode: "read_only", revision: 0 });
			await host.branchSession(session.id);
			expect(host.toolPolicy()).toMatchObject({ mode: "read_only", revision: 0 });
		} finally {
			await host.dispose();
			await removeFactory();
			await context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});
	it("keeps Web-style tool approvals scoped to the host that created the session", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-host-root-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-host-agent-"));
		await Promise.all([
			writeFile(join(root, "first.txt"), "first", "utf8"),
			writeFile(join(root, "second.txt"), "second", "utf8"),
		]);
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "first-read", name: "read", arguments: { path: "first.txt" } }],
				},
				{ type: "success", content: [{ type: "text", text: "first complete" }] },
				{
					type: "success",
					content: [{ type: "tool_call", id: "second-read", name: "read", arguments: { path: "second.txt" } }],
				},
				{ type: "success", content: [{ type: "text", text: "second complete" }] },
			],
		});
		const firstApprovals: string[] = [];
		const secondApprovals: string[] = [];
		const runtime = await setup(root, agentDir, faux, undefined, {
			request: async (toolName) => {
				firstApprovals.push(toolName);
			},
		});
		const second = await createSessionHost(runtime.context, {
			cwd: root,
			agentDir,
			provider: faux.provider,
			model: faux.model,
			toolApproval: {
				request: async (toolName) => {
					secondApprovals.push(toolName);
				},
			},
		});
		try {
			await runtime.host.createSession();
			await second.createSession();
			await runtime.host.prompt("read first");
			await second.prompt("read second");
			expect(firstApprovals).toEqual(["read"]);
			expect(secondApprovals).toEqual(["read"]);
		} finally {
			await second.dispose();
			await runtime.host.dispose();
			await runtime.removeFactory();
			await runtime.context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("creates, persists, closes, and reopens an opaque session", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-host-root-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-host-agent-"));
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "saved one" }] },
				{ type: "success", content: [{ type: "text", text: "saved two" }] },
				{ type: "success", content: [{ type: "text", text: "persistent summary" }] },
			],
		});
		const runtime = await setup(root, agentDir, faux, { keepRecentTokens: 1 });
		try {
			expect(runtime.context.require(workspaceCapabilityKey).allowedRoot).toBe(root);
			const created = await runtime.host.createSession();
			await expect(runtime.host.prompt("remember this")).resolves.toMatchObject({ stopReason: "stop" });
			await expect(runtime.host.prompt("remember that too")).resolves.toMatchObject({ stopReason: "stop" });
			await runtime.host.compact();
			const usage = runtime.host.usage();
			expect(runtime.host.tree().some((node) => JSON.stringify(node).includes("persistent summary"))).toBe(true);
			expect((await runtime.host.listSessions()).map((item) => item.id)).toContain(created.id);
			await runtime.host.closeSession();
			await expect(runtime.host.closeSession()).resolves.toBeUndefined();
			await expect(runtime.host.openSession(created.id)).resolves.toMatchObject({ id: created.id });
			expect(runtime.host.transcript().map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(runtime.host.usage()).toMatchObject({ requestCount: 2, totalTokens: usage.totalTokens });
			expect(runtime.host.tree().some((node) => JSON.stringify(node).includes("persistent summary"))).toBe(true);
		} finally {
			await runtime.host.dispose();
			await expect(runtime.host.dispose()).resolves.toBeUndefined();
			await runtime.removeFactory();
			await runtime.context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps actors isolated and rejects session changes while an operation is active", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-host-actors-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-host-actors-agent-"));
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [
				{ type: "success", content: [{ type: "text", text: "seeded" }] },
				{ type: "success", content: [{ type: "text", text: "x".repeat(5000) }] },
			],
		});
		const first = await setup(root, agentDir, faux);
		const manager = new HostManager(first.context);
		try {
			await first.host.dispose();
			const a = await manager.get({
				principal: "one",
				cwd: root,
				agentDir,
				provider: faux.provider,
				model: faux.model,
			});
			const b = await manager.get({
				principal: "two",
				cwd: root,
				agentDir,
				provider: faux.provider,
				model: faux.model,
			});
			expect(a).not.toBe(b);
			await a.createSession();
			await a.prompt("seed persisted session");
			const sessionId = a.state().activeSession?.id;
			if (!sessionId) throw new Error("Expected active Session ID");
			await expect(b.openSession(sessionId)).rejects.toMatchObject({ code: "SESSION_IN_USE" });
			const pending = a.prompt({ text: "busy", requestId: "busy-request" });
			expect(() => a.setModel(faux.model.id)).toThrowError(SessionHostError);
			expect(a.cancel("busy-request")).toBe(true);
			await pending;
			expect(b.state().activeSession).toBeUndefined();
		} finally {
			await manager.dispose();
			await first.removeFactory();
			await first.context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("persists the failed prompt target so retry survives Host reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-host-retry-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-host-retry-agent-"));
		const faux = createFauxProvider({
			responses: [
				{ type: "failure", errorMessage: "temporary failure" },
				{ type: "success", content: [{ type: "text", text: "retried" }] },
			],
		});
		let runtime = await setup(root, agentDir, faux);
		let sessionId: string | undefined;
		try {
			const created = await runtime.host.createSession();
			sessionId = created.id;
			await expect(runtime.host.prompt({ text: "try again", requestId: "failed-request" })).resolves.toMatchObject({
				stopReason: "error",
			});
		} finally {
			await runtime.host.dispose();
			await runtime.removeFactory();
			await runtime.context.dispose();
		}
		if (!sessionId) throw new Error("Expected persisted Session ID");
		runtime = await setup(root, agentDir, faux);
		try {
			await runtime.host.openSession(sessionId);
			await expect(runtime.host.retry({ targetRequestId: "failed-request" })).resolves.toMatchObject({
				stopReason: "stop",
			});
		} finally {
			await runtime.host.dispose();
			await runtime.removeFactory();
			await runtime.context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("supports opaque session inspection, rename, branch, and confirmed deletion", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-host-depth-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-host-depth-agent-"));
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first answer" }] },
				{ type: "success", content: [{ type: "text", text: "later answer" }] },
			],
		});
		const runtime = await setup(root, agentDir, faux);
		try {
			const created = await runtime.host.createSession();
			await runtime.host.prompt("hello");
			const firstAssistantEntryId = runtime.host.tree()[0]?.children[0]?.entry.id;
			if (!firstAssistantEntryId) throw new Error("Expected the first assistant Session entry.");
			await runtime.host.prompt("continue");
			const inspected = await runtime.host.inspectSession(created.id);
			expect(inspected.readOnly).toBe(true);
			expect(inspected.stats.messageCount).toBe(4);
			await expect(runtime.host.renameSession(created.id, "Renamed")).resolves.toMatchObject({ label: "Renamed" });
			const branch = await runtime.host.branchSession(created.id, firstAssistantEntryId);
			expect(branch.id).not.toBe(created.id);
			expect(runtime.host.state().activeSession?.id).toBe(branch.id);
			expect(runtime.host.transcript().map((message) => JSON.stringify(message))).toEqual([
				expect.stringContaining("hello"),
				expect.stringContaining("first answer"),
			]);
			await expect(runtime.host.deleteSession(created.id, "wrong")).rejects.toMatchObject({ code: "INVALID_INPUT" });
			await runtime.host.closeSession();
			await runtime.host.deleteSession(created.id, created.id);
			expect((await runtime.host.listSessions()).some((item) => item.id === created.id)).toBe(false);
		} finally {
			await runtime.host.dispose();
			await runtime.removeFactory();
			await runtime.context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("retries a cancelled prompt by its original request ID", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-host-cancel-retry-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-host-cancel-retry-agent-"));
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [
				{ type: "success", content: [{ type: "text", text: "x".repeat(10_000) }] },
				{ type: "success", content: [{ type: "text", text: "retried after cancellation" }] },
			],
		});
		const runtime = await setup(root, agentDir, faux);
		try {
			await runtime.host.createSession();
			const pending = runtime.host.prompt({ text: "cancel then retry", requestId: "cancelled-request" });
			expect(runtime.host.cancel("cancelled-request")).toBe(true);
			await expect(pending).resolves.toMatchObject({ stopReason: "aborted" });
			await expect(runtime.host.retry({ targetRequestId: "cancelled-request" })).resolves.toMatchObject({
				stopReason: "stop",
			});
		} finally {
			await runtime.host.dispose();
			await runtime.removeFactory();
			await runtime.context.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
