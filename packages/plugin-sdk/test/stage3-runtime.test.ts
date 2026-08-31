import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type BridgePort,
	DurableTaskStore,
	type ExtensionId,
	replayTaskRecords,
	type SessionId,
	SessionRuntimeManager,
	WebBundleBridge,
} from "../src/index.ts";

describe("freedom stage 3 runtime", () => {
	it("replays durable records and marks an incomplete task for reconciliation", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-stage3-"));
		try {
			const store = new DurableTaskStore(join(root, "tasks.jsonl"));
			const base = { taskId: "task-a" as never, timestamp: new Date().toISOString() };
			await store.append({ ...base, type: "task_created", sequence: 1, state: "starting" });
			await store.append({ ...base, type: "task_state", sequence: 2, state: "running" });
			const projection = replayTaskRecords(await store.read(), "task-a" as never);
			expect(projection.needsReconciliation).toBe(true);
			expect(projection.snapshot.state).toBe("needs_reconciliation");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps session runtimes alive while views change", async () => {
		const manager = new SessionRuntimeManager(async (sessionId) => ({ sessionId }));
		const a = await manager.open("a" as SessionId);
		const b = await manager.open("b" as SessionId);
		expect(a).not.toBe(b);
		expect(manager.get("a" as SessionId)).toBe(a);
		await manager.close("b" as SessionId);
		expect(manager.get("a" as SessionId)).toBe(a);
		await manager.dispose();
	});

	it("requires the exact origin/source/nonce before accepting actions", async () => {
		const sent: unknown[] = [];
		const listeners = new Set<(event: { data: never; origin: string; source: unknown }) => void>();
		const port: BridgePort = {
			postMessage: (message) => sent.push(message),
			addEventListener: (_type, listener) => listeners.add(listener as never),
			removeEventListener: (_type, listener) => listeners.delete(listener as never),
		};
		const source = {};
		const bridge = new WebBundleBridge(port, {
			pluginId: "demo" as ExtensionId,
			origin: "https://bundle.invalid",
			source,
			action: async () => "ok",
		});
		const hello = sent[0] as { nonce: string; instanceId: string };
		for (const listener of listeners)
			listener({
				data: { type: "ready", protocolVersion: 1, instanceId: hello.instanceId, nonce: "bad" } as never,
				origin: "https://bundle.invalid",
				source,
			});
		for (const listener of listeners)
			listener({
				data: { type: "ready", protocolVersion: 1, instanceId: hello.instanceId, nonce: hello.nonce } as never,
				origin: "https://bundle.invalid",
				source,
			});
		expect((sent[1] as { type: string }).type).toBe("snapshot");
		bridge.dispose();
	});
});
