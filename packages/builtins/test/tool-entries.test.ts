import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@di-code/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDefaultToolCapabilities,
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
});
