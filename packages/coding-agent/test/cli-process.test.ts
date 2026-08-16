import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entryPath = resolve(process.cwd(), "dist/entry.js");

async function runCli(
	args: string[],
	options: { readonly configured?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const root = await mkdtemp(join(tmpdir(), "di-code-cli-process-"));
	const sessionPath = join(root, "session.jsonl");
	const needsSession =
		args.length > 0 &&
		!args.includes("--help") &&
		!args.includes("-h") &&
		!args.includes("--version") &&
		!args.includes("-v");
	try {
		const environment = { ...process.env };
		if (options.configured ?? true) environment.DI_CODE_PROVIDER = "faux";
		else {
			delete environment.DI_CODE_PROVIDER;
			delete environment.DI_CODE_MODEL;
			delete environment.OPENAI_API_KEY;
			delete environment.DEEPSEEK_API_KEY;
		}
		return await new Promise((resolveResult, reject) => {
			const child = spawn(process.execPath, [entryPath, ...args, ...(needsSession ? ["--session", sessionPath] : [])], {
				cwd: process.cwd(),
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => resolveResult({ code, stdout, stderr }));
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("CLI process entry", () => {
	it("prints help without runtime diagnostics", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage: di-code");
		expect(result.stderr).toBe("");
	});

	it("prints the package version", async () => {
		const result = await runCli(["--version"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("0.0.0\n");
		expect(result.stderr).toBe("");
	});

	it("runs the deterministic print path", async () => {
		const result = await runCli(["--print", "hello"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("Faux response.\n");
		expect(result.stderr).toBe("");
	});

	it("writes versioned JSON events", async () => {
		const result = await runCli(["--mode", "json", "hello"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const records = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { version: number; event: { type: string } });
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((record) => record.version === 2)).toBe(true);
		expect(records.map((record) => record.event.type)).toContain("agent_start");
		expect(records.map((record) => record.event.type)).toContain("agent_end");
	});

	it("keeps usage errors off stdout", async () => {
		const result = await runCli(["--unknown"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain('Unknown option "--unknown".');
	});

	it("fails fast without provider configuration when stdin is not a TTY", async () => {
		const result = await runCli(["--print", "hello"], { configured: false });

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"Provider is not configured. Set DI_CODE_PROVIDER or start interactive mode in a TTY.\n",
		);
		expect(result.stderr).not.toContain("at ");
	});

	it("does not wait for onboarding on a bare non-TTY launch", async () => {
		const result = await runCli([], { configured: false });

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"Provider is not configured. Set DI_CODE_PROVIDER or start interactive mode in a TTY.\n",
		);
	});
});
