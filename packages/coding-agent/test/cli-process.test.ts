import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entryPath = resolve(process.cwd(), "dist/entry.js");

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolveResult, reject) => {
		const child = spawn(process.execPath, [entryPath, ...args], {
			cwd: process.cwd(),
			env: { ...process.env, DI_CODE_PROVIDER: "faux" },
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
		expect(records.every((record) => record.version === 1)).toBe(true);
		expect(records.map((record) => record.event.type)).toContain("agent_start");
		expect(records.map((record) => record.event.type)).toContain("agent_end");
	});

	it("keeps usage errors off stdout", async () => {
		const result = await runCli(["--unknown"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain('Unknown option "--unknown".');
	});
});
