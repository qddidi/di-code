import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(new URL("./fixtures/session-process.ts", import.meta.url));

async function runFixture(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", fixturePath, ...args], {
			cwd: process.cwd(),
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
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

async function waitForFiles(filePaths: readonly string[]): Promise<void> {
	while (true) {
		const ready = await Promise.all(
			filePaths.map(async (filePath) => {
				try {
					await access(filePath);
					return true;
				} catch {
					return false;
				}
			}),
		);
		if (ready.every(Boolean)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("session cross-process recovery", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-session-process-"));
		sessionFile = join(root, "session.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("restores messages written by a different Node process", async () => {
		const written = await runFixture(["write", sessionFile, root]);
		expect(written).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(written.stdout)).toEqual({ sessionFile });

		const read = await runFixture(["read", sessionFile, root]);
		expect(read).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(read.stdout)).toEqual({
			roles: ["user", "assistant"],
			texts: ["saved-question", "saved-answer"],
		});
	});

	it("allows only one process to append from the same old leaf", async () => {
		const written = await runFixture(["write", sessionFile, root]);
		expect(written.code).toBe(0);
		const readyA = join(root, "ready-a");
		const readyB = join(root, "ready-b");
		const gate = join(root, "gate");

		const first = runFixture(["append", sessionFile, root, "from-a", readyA, gate]);
		const second = runFixture(["append", sessionFile, root, "from-b", readyB, gate]);
		await waitForFiles([readyA, readyB]);
		await writeFile(gate, "go", "utf8");
		const results = await Promise.all([first, second]);

		expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
		const payloads = results.map((result) => JSON.parse(result.stdout) as { status: string; code?: string });
		expect(payloads.filter((payload) => payload.status === "appended")).toHaveLength(1);
		expect(payloads.filter((payload) => payload.code === "CONCURRENT_MODIFICATION")).toHaveLength(1);
		const read = await runFixture(["read", sessionFile, root]);
		const restored = JSON.parse(read.stdout) as { roles: string[]; texts: string[] };
		expect(restored.roles).toEqual(["user", "assistant", "user"]);
		expect(restored.texts.slice(0, 2)).toEqual(["saved-question", "saved-answer"]);
		expect(["from-a", "from-b"]).toContain(restored.texts[2]);
	});
});
