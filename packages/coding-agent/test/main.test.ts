import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@di-code/agent";
import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { runMain } from "../src/main.ts";

function createIo() {
	return { stdout: vi.fn(), stderr: vi.fn() };
}

function createRuntime(responses: readonly FauxResponse[]) {
	const faux = createFauxProvider({ responses });
	return () => ({ provider: faux.provider, model: faux.model });
}

describe("runMain", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-main-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("runs a read tool turn through print mode and prints only the final answer", async () => {
		await writeFile(join(root, "print.txt"), "print file content", "utf8");
		const io = createIo();
		const exitCode = await runMain(["--print", "read print.txt"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			createRuntime: createRuntime([
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "main-print-read",
							name: "read",
							arguments: { path: "print.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Print read completed." }] },
			]),
		});

		expect(exitCode).toBe(0);
		expect(io.stdout).toHaveBeenCalledTimes(1);
		expect(io.stdout).toHaveBeenCalledWith("Print read completed.\n");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("runs a successful read tool turn through versioned JSON mode", async () => {
		await writeFile(join(root, "json.txt"), "json file content", "utf8");
		const io = createIo();
		const exitCode = await runMain(["--mode", "json", "read json.txt"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			createRuntime: createRuntime([
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "main-json-read",
							name: "read",
							arguments: { path: "json.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "JSON read completed." }] },
			]),
		});

		expect(exitCode).toBe(0);
		expect(io.stderr).not.toHaveBeenCalled();
		const records = io.stdout.mock.calls.map(
			([line]) => JSON.parse(line.trim()) as { version: number; event: AgentEvent },
		);
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((record) => record.version === 2)).toBe(true);
		const toolEnd = records
			.map((record) => record.event)
			.find((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => {
				return event.type === "tool_execution_end";
			});
		expect(toolEnd?.result).toMatchObject({
			toolCallId: "main-json-read",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "json file content" }],
		});
		expect(records.map((record) => record.event.type)).toContain("agent_end");
	});

	it("preserves help as a no-runtime command", async () => {
		const io = createIo();
		const createRuntime = vi.fn(() => {
			throw new Error("help must not create a runtime");
		});
		const exitCode = await runMain(["--help"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			createRuntime,
		});

		expect(exitCode).toBe(0);
		expect(createRuntime).not.toHaveBeenCalled();
		expect(io.stdout.mock.calls[0]?.[0]).toContain("Usage: di-code");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("creates and resumes the default persistent session", async () => {
		const io = createIo();
		const firstExit = await runMain(["--print", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "first" }] }]),
		});

		expect(firstExit).toBe(0);
		const sessionFile = join(root, ".di-code", "sessions", "default.jsonl");
		expect(await import("node:fs/promises").then(({ access }) => access(sessionFile))).toBeUndefined();

		const secondExit = await runMain(["--print", "again"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "second" }] }]),
		});
		const restored = await SessionManager.open(sessionFile);

		expect(secondExit).toBe(0);
		expect(restored.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	});
});
