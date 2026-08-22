import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLineDecoder, serializeJsonLine } from "../src/rpc/jsonl.ts";
import { RPC_PROTOCOL_VERSION, type RpcServerMessage } from "../src/rpc/protocol.ts";

const entryPath = resolve(process.cwd(), "src/rpc-entry.ts");

async function readRpcRecord(
	child: ReturnType<typeof spawn>,
	predicate: (record: RpcServerMessage) => boolean,
): Promise<RpcServerMessage> {
	const stdout = child.stdout;
	if (!stdout) throw new Error("RPC child stdout is unavailable.");
	return await new Promise<RpcServerMessage>((resolveRecord, reject) => {
		const decoder = new JsonlLineDecoder((line) => {
			try {
				const record = JSON.parse(line) as RpcServerMessage;
				if (predicate(record)) resolveRecord(record);
			} catch (cause) {
				reject(cause);
			}
		});
		stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
		stdout.once("error", reject);
		child.once("exit", (code) => reject(new Error(`RPC child exited before response (code=${code}).`)));
	});
}

describe("stage 0 runtime behavior baseline", () => {
	it("runs faux RPC get_state, prompt, and cancel through the source entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-baseline-rpc-"));
		const child = spawn(process.execPath, ["--experimental-strip-types", entryPath], {
			cwd: root,
			env: { ...process.env, DI_CODE_PROVIDER: "faux" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		try {
			if (!child.stdin) throw new Error("RPC child stdin is unavailable.");
			child.stdin.write(
				serializeJsonLine({
					version: RPC_PROTOCOL_VERSION,
					kind: "request",
					id: "state",
					method: "get_state",
					params: {},
				}),
			);
			await expect(
				readRpcRecord(child, (record) => record.kind === "response" && record.id === "state"),
			).resolves.toMatchObject({
				ok: true,
				result: { method: "get_state" },
			});

			child.stdin.write(
				serializeJsonLine({
					version: RPC_PROTOCOL_VERSION,
					kind: "request",
					id: "prompt",
					method: "prompt",
					params: { message: "baseline" },
				}),
			);
			await expect(
				readRpcRecord(child, (record) => record.kind === "response" && record.id === "prompt"),
			).resolves.toMatchObject({
				ok: true,
				result: { method: "prompt" },
			});

			child.stdin.write(
				serializeJsonLine({
					version: RPC_PROTOCOL_VERSION,
					kind: "request",
					id: "cancel",
					method: "cancel",
					params: { requestId: "missing-request" },
				}),
			);
			await expect(
				readRpcRecord(child, (record) => record.kind === "response" && record.id === "cancel"),
			).resolves.toMatchObject({
				ok: true,
				result: { method: "cancel", cancelled: false },
			});
		} finally {
			child.stdin?.end();
			await once(child, "exit");
			await rm(root, { recursive: true, force: true });
		}
	});
});
