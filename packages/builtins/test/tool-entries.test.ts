import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@di-code/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDefaultToolCapabilities,
	createGenerateImageTool,
	createSessionToolPolicy,
	ToolPolicyError,
	toolApproval,
	toolApprovalKey,
	toolEdit,
	toolGlob,
	toolGrep,
	toolOutput,
	toolOutputKey,
	toolPolicy,
	toolPolicyKey,
	toolRead,
	toolRegistry,
	toolRegistryKey,
	toolWrite,
	workspace,
} from "../src/index.ts";

const directories: string[] = [];

async function createWorkspace(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "di-code-tool-entry-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("tool composition entries", () => {
	it("registers workspace tools through ToolRegistry and removes a tool when its Fiber unloads", async () => {
		const root = await createWorkspace();
		await writeFile(join(root, "notes.txt"), "alpha", "utf8");
		const context = createRootContext({ id: "tool-entry-test" });
		try {
			await context.plugin(toolRegistry, undefined);
			await context.plugin(workspace, { allowedRoot: root });
			await context.plugin(toolApproval, undefined);
			await context.plugin(toolPolicy, undefined);
			await context.plugin(toolOutput, undefined);
			const readFiber = await context.plugin(toolRead, undefined);
			await context.plugin(toolWrite, undefined);
			await context.plugin(toolEdit, undefined);
			await context.plugin(toolGlob, undefined);
			await context.plugin(toolGrep, undefined);

			const registry = context.require(toolRegistryKey);
			const capabilities = createDefaultToolCapabilities(root);
			expect(registry.snapshot(capabilities).map((tool) => tool.name)).toEqual([
				"edit",
				"glob",
				"grep",
				"read",
				"write",
			]);
			const read = registry.snapshot(capabilities).find((tool) => tool.name === "read");
			if (!read) throw new Error("read tool was not registered");
			const result = await read.execute("read-1", { path: "notes.txt" } as never);
			expect(result).toEqual([{ type: "text", text: "alpha" }]);

			await readFiber.dispose();
			expect(registry.snapshot(capabilities).map((tool) => tool.name)).toEqual(["edit", "glob", "grep", "write"]);
		} finally {
			await context.dispose();
		}
	});

	it("reserves tool names and routes execution through policy, approval, and output capabilities", async () => {
		const root = await createWorkspace();
		const context = createRootContext({ id: "tool-policy-test" });
		const events: string[] = [];
		try {
			await context.plugin(toolRegistry, undefined);
			await context.plugin(workspace, { allowedRoot: root });
			context.set(toolPolicyKey, {
				authorize: () => {
					events.push("policy");
				},
			});
			context.set(toolApprovalKey, {
				request: () => {
					events.push("approval");
				},
			});
			context.set(toolOutputKey, {
				present: (result) => {
					events.push("output");
					return result;
				},
			});
			await context.plugin(toolRead, undefined);
			expect(() => context.require(toolRegistryKey).registerFactory("read", () => undefined)).toThrow(
				"Reserved tool name",
			);
			const read = context
				.require(toolRegistryKey)
				.snapshot({
					...createDefaultToolCapabilities(root),
					policy: context.require(toolPolicyKey),
					approval: context.require(toolApprovalKey),
					output: context.require(toolOutputKey),
				})
				.find((tool) => tool.name === "read");
			if (!read) throw new Error("read tool was not registered");
			await expect(read.execute("missing", { path: "missing.txt" } as never)).rejects.toMatchObject({ code: "ENOENT" });
			expect(events).toEqual(["policy", "approval"]);
		} finally {
			await context.dispose();
		}
	});

	it("enforces a denying policy before approval or tool execution", async () => {
		const root = await createWorkspace();
		const context = createRootContext({ id: "tool-policy-deny-baseline" });
		const calls: string[] = [];
		try {
			await context.plugin(toolRegistry, undefined);
			await context.plugin(workspace, { allowedRoot: root });
			context.set(toolPolicyKey, {
				authorize: () => {
					calls.push("policy");
					throw new Error("denied by baseline policy");
				},
			});
			context.set(toolApprovalKey, { request: () => void calls.push("approval") });
			await context.plugin(toolRead, undefined);
			const read = context
				.require(toolRegistryKey)
				.snapshot({
					...createDefaultToolCapabilities(root),
					policy: context.require(toolPolicyKey),
					approval: context.require(toolApprovalKey),
				})
				.find((tool) => tool.name === "read");
			if (!read) throw new Error("read tool was not registered");

			await expect(read.execute("read-denied", { path: "missing.txt" } as never)).rejects.toThrow(
				"denied by baseline policy",
			);
			expect(calls).toEqual(["policy"]);
		} finally {
			await context.dispose();
		}
	});

	it("keeps a per-session read-only boundary atomic and cancellation-aware", async () => {
		const persisted: string[] = [];
		let reads = 0;
		const policy = createSessionToolPolicy({
			sessionId: "session-a",
			projection: () => {
				reads++;
				return { plan: true };
			},
			pluginState: () => {
				reads++;
				return { trusted: true };
			},
			persistMode: async (mode) => {
				persisted.push(mode);
			},
		});
		const write = () => policy.authorize("write", { path: "x" });
		await Promise.all([policy.setMode?.("read_only"), policy.setMode?.("read_only")]);
		expect(policy.snapshot?.()).toMatchObject({ mode: "read_only", revision: 1, sessionId: "session-a" });
		expect(persisted).toEqual(["read_only"]);
		expect(write).toThrow(/read-only/);
		policy.authorize("read", {});
		expect(reads).toBe(2);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const cancelled = () => Promise.resolve().then(() => policy.authorize("read", {}, controller.signal));
		await expect(cancelled()).rejects.toBeInstanceOf(ToolPolicyError);
		await expect(cancelled()).rejects.toMatchObject({ code: "POLICY_CANCELLED" });
		const timed = createSessionToolPolicy({
			sessionId: "session-timeout",
			timeoutMs: 1,
			persistMode: () => new Promise<void>(() => undefined),
		});
		await expect(timed.setMode?.("read_only")).rejects.toMatchObject({ code: "POLICY_TIMEOUT" });
	});

	it("returns generated images and stores them outside the workspace", async () => {
		const root = await createWorkspace();
		const artifacts = await createWorkspace();
		const tool = createGenerateImageTool({
			provider: {
				id: "test-images",
				name: "Test Images",
				generate: async () => [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
			},
			artifactDirectory: artifacts,
		});
		const result = await tool.execute("call-1", { prompt: "draw" });
		expect(result[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
		expect(result.at(-1)).toMatchObject({ type: "text" });
		expect(await readdir(artifacts)).toHaveLength(1);
		expect(await readdir(root)).toHaveLength(0);
	});
});
