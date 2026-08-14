import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@di-code/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../src/main.ts";

function createIo() {
	return { stdout: vi.fn(), stderr: vi.fn() };
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
			fauxResponses: [
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
			],
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
			fauxResponses: [
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
			],
		});

		expect(exitCode).toBe(0);
		expect(io.stderr).not.toHaveBeenCalled();
		const records = io.stdout.mock.calls.map(
			([line]) => JSON.parse(line.trim()) as { version: number; event: AgentEvent },
		);
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((record) => record.version === 1)).toBe(true);
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
		const exitCode = await runMain(["--help"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			fauxResponses: [],
		});

		expect(exitCode).toBe(0);
		expect(io.stdout.mock.calls[0]?.[0]).toContain("Usage: di-code");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("rejects Anthropic CLI mode before a request when the API key is missing", async () => {
		const io = createIo();
		const exitCode = await runMain(["--provider", "anthropic", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			fauxResponses: [],
			env: {},
		});

		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith("Anthropic API key is required\n");
	});

	it("rejects OpenAI CLI mode before a request when the API key is missing", async () => {
		const io = createIo();
		const exitCode = await runMain(["--provider", "openai", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			fauxResponses: [],
			env: {},
		});

		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith("OpenAI API key is required\n");
	});

	it("rejects an unknown Anthropic model before creating a session", async () => {
		const io = createIo();
		const exitCode = await runMain(["--provider", "anthropic", "--model", "missing-model", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			fauxResponses: [],
			env: { ANTHROPIC_API_KEY: "test-key" },
		});

		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith('Unknown anthropic model "missing-model".\n');
	});

	it("starts interactive mode without a prompt and applies project settings", async () => {
		const io = createIo();
		const interactive = vi.fn(async () => 0);
		await mkdir(join(root, ".di-code"), { recursive: true });
		await writeFile(
			join(root, ".di-code", "settings.json"),
			JSON.stringify({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				providers: { anthropic: { apiKeyEnv: "PROJECT_ANTHROPIC_KEY" } },
			}),
		);
		const exitCode = await runMain([], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			cwd: root,
			env: { PROJECT_ANTHROPIC_KEY: "test-key" },
			fauxResponses: [],
			interactive,
		});

		expect(exitCode).toBe(0);
		expect(interactive).toHaveBeenCalledWith(expect.anything(), "");
	});

	it("lets CLI provider and model override settings", async () => {
		const io = createIo();
		const interactive = vi.fn(async () => 0);
		const exitCode = await runMain(["--provider", "faux", "--model", "faux-model", "--interactive"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			cwd: root,
			env: { DI_CODE_PROVIDER: "anthropic", ANTHROPIC_MODEL: "missing-model" },
			fauxResponses: [],
			interactive,
		});

		expect(exitCode).toBe(0);
		expect(interactive).toHaveBeenCalledWith(expect.anything(), "");
	});

	it("selects an explicitly requested model for a custom provider", async () => {
		const io = createIo();
		const interactive = vi.fn(async (session: { model: { id: string } }) => {
			expect(session.model.id).toBe("second-model");
			return 0;
		});
		await mkdir(join(root, ".di-code"), { recursive: true });
		await writeFile(
			join(root, ".di-code", "models.json"),
			JSON.stringify({
				providers: {
					"local-openai": {
						api: "openai-responses",
						apiKeyEnv: "LOCAL_KEY",
						models: [{ id: "first-model" }, { id: "second-model" }],
					},
				},
			}),
		);
		const exitCode = await runMain(["--provider", "local-openai", "--model", "second-model", "--interactive"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			cwd: root,
			env: { LOCAL_KEY: "test-key" },
			fauxResponses: [],
			interactive,
		});

		expect(exitCode).toBe(0);
		expect(io.stderr).not.toHaveBeenCalled();
	});
});
