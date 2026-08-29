import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";

describe("Session typed event persistence", () => {
	it("serializes concurrent appends and restores events for a fork", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-events-"));
		const manager = await SessionManager.create({ filePath: join(root, "source.jsonl"), cwd: root });
		await Promise.all([
			manager.appendEvent({ namespace: "demo", eventName: "x", schemaVersion: 1, payload: { value: 1 } }),
			manager.appendEvent({ namespace: "demo", eventName: "x", schemaVersion: 1, payload: { value: 2 } }),
		]);
		expect(manager.events.map((event) => event.payload)).toEqual([{ value: 1 }, { value: 2 }]);
		const reopened = await SessionManager.open(manager.filePath);
		expect(reopened.events).toHaveLength(2);
	});

	it("retains unknown event records and diagnostics for malformed records", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-events-"));
		const file = join(root, "session.jsonl");
		const manager = await SessionManager.create({ filePath: file, cwd: root });
		const header = JSON.stringify(manager.header);
		await writeFile(
			file,
			`${header}\n${JSON.stringify({ type: "event", version: 2, id: "bad", parentId: manager.header.id, timestamp: "bad", namespace: "unknown", eventName: "x", schemaVersion: 1, payload: {} })}\n`,
		);
		const loaded = await SessionManager.open(file);
		expect(loaded.diagnostics).toHaveLength(1);
		expect((await readFile(file, "utf8")).split("\n")).toHaveLength(3);
	});

	it("honors cancellation before entering the append queue", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-events-"));
		const manager = await SessionManager.create({ filePath: join(root, "session.jsonl"), cwd: root });
		const controller = new AbortController();
		controller.abort();
		await expect(
			manager.appendEvent({
				namespace: "demo",
				eventName: "x",
				schemaVersion: 1,
				payload: {},
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(manager.events).toHaveLength(0);
	});
});
