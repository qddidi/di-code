import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entryPath = resolve(process.cwd(), "src/entry.ts");

describe("minimal profile subprocess", () => {
	it("runs Faux print through Loader and releases session resources", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-minimal-profile-"));
		try {
			const result = await new Promise<{
				readonly code: number | null;
				readonly stdout: string;
				readonly stderr: string;
			}>((resolveResult, reject) => {
				const child = spawn(process.execPath, ["--experimental-strip-types", entryPath, "--print", "hello"], {
					cwd: root,
					env: { ...process.env, DI_CODE_PROVIDER: "faux", DI_CODE_MODEL: "faux-model", DI_CODE_TRACE_PLUGINS: "1" },
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
				child.once("error", reject);
				child.once("close", (code) => resolveResult({ code, stdout, stderr }));
			});
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("Faux response\n");
			const events = result.stderr
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string; pluginName?: string; status?: string });
			expect(events).toContainEqual(
				expect.objectContaining({ type: "plugin_status", pluginName: "mode-print", status: "active" }),
			);
			expect(events).toContainEqual({ type: "session_dispose" });
			expect(result.stderr).not.toContain("Required entry");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
