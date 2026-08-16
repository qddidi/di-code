import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/rpc/client.ts";

const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
	await Promise.all(
		[...children].map(async (child) => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
		}),
	);
	children.clear();
});

describe("di-code-rpc process", () => {
	it("serves a versioned faux-provider conversation over stdin/stdout", async () => {
		const entryPath = fileURLToPath(new URL("../src/rpc-entry.ts", import.meta.url));
		const child = spawn(process.execPath, ["--experimental-strip-types", entryPath], {
			cwd: process.cwd(),
			env: { ...process.env, DI_CODE_PROVIDER: "faux" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.add(child);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const client = new RpcClient({
			readable: child.stdout,
			writable: child.stdin,
			onExit(listener) {
				child.on("exit", listener);
				return () => child.off("exit", listener);
			},
		});

		await expect(client.getState()).resolves.toMatchObject({
			modelId: "faux-model",
			isStreaming: false,
			messageCount: 0,
		});
		await expect(client.prompt("hello")).resolves.toMatchObject({
			stopReason: "stop",
			provider: "faux",
		});
		expect(stderr).toBe("");

		client.close();
		child.stdin.end();
		await once(child, "exit");
	});
});
