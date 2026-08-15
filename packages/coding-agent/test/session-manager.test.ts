import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Message } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";

function userMessage(text: string, timestamp: number): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function idSequence(...ids: string[]): () => string {
	let index = 0;
	return () => {
		const id = ids[index++];
		if (id === undefined) throw new Error("ID sequence exhausted.");
		return id;
	};
}

describe("SessionManager", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-session-manager-"));
		sessionFile = join(root, "session.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("creates a deterministic empty session", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			now: () => Date.parse("2026-08-12T13:00:00.000Z"),
			createId: idSequence("session-1"),
		});

		expect(manager.filePath).toBe(resolve(sessionFile));
		expect(manager.header).toEqual({
			type: "session",
			version: 1,
			id: "session-1",
			parentId: null,
			timestamp: "2026-08-12T13:00:00.000Z",
			cwd: resolve(root),
		});
		expect(manager.entries).toEqual([]);
		expect(manager.messages).toEqual([]);
		expect(manager.leafId).toBe("session-1");
	});

	it("can defer creating an empty session file until the first append", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			deferCreate: true,
			now: () => Date.parse("2026-08-12T13:00:00.000Z"),
			createId: idSequence("session-1", "entry-1"),
		});

		await expect(access(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
		await manager.appendMessage(userMessage("first", 1));
		await expect(access(sessionFile)).resolves.toBeUndefined();
		expect((await SessionManager.open(sessionFile)).messages).toEqual([userMessage("first", 1)]);
	});

	it("appends messages as a linear parent chain", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			now: () => Date.parse("2026-08-12T13:00:00.000Z"),
			createId: idSequence("session-1", "entry-1", "entry-2"),
		});

		const first = await manager.appendMessage(userMessage("first", 1));
		const second = await manager.appendMessage(userMessage("second", 2));

		expect(first.parentId).toBe("session-1");
		expect(second.parentId).toBe("entry-1");
		expect(manager.entries.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
			{ id: "entry-1", parentId: "session-1" },
			{ id: "entry-2", parentId: "entry-1" },
		]);
		expect(manager.leafId).toBe("entry-2");
	});

	it("opens an existing session with messages, leaf, and diagnostics", async () => {
		const created = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1"),
		});
		await created.appendMessage(userMessage("saved", 1));
		await writeFile(sessionFile, `${await readFile(sessionFile, "utf8")}{`, "utf8");

		const opened = await SessionManager.open(sessionFile);

		expect(opened.header.id).toBe("session-1");
		expect(opened.messages).toEqual([userMessage("saved", 1)]);
		expect(opened.leafId).toBe("entry-1");
		expect(opened.diagnostics).toMatchObject([{ kind: "trailing_partial_line", lineNumber: 3 }]);
	});

	it("serializes concurrent appends on one manager in call order", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1", "entry-2"),
		});

		await Promise.all([
			manager.appendMessage(userMessage("first", 1)),
			manager.appendMessage(userMessage("second", 2)),
		]);

		expect(manager.messages).toEqual([userMessage("first", 1), userMessage("second", 2)]);
		expect(manager.entries[1]?.parentId).toBe("entry-1");
	});

	it("allows only one manager to append from the same old leaf", async () => {
		await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1"),
		});
		const first = await SessionManager.open(sessionFile, { createId: idSequence("entry-a") });
		const second = await SessionManager.open(sessionFile, { createId: idSequence("entry-b") });

		const results = await Promise.allSettled([
			first.appendMessage(userMessage("from-a", 1)),
			second.appendMessage(userMessage("from-b", 2)),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(rejected?.reason).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
		const reloaded = await SessionManager.open(sessionFile);
		expect(reloaded.entries).toHaveLength(1);
	});

	it("does not mutate memory or poison its queue after an append failure", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1", "entry-2"),
			appendOptions: { lockTimeoutMs: 0 },
		});
		await writeFile(`${sessionFile}.lock`, "held", "utf8");

		await expect(manager.appendMessage(userMessage("blocked", 1))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
		expect(manager.messages).toEqual([]);
		expect(manager.leafId).toBe("session-1");
		await unlink(`${sessionFile}.lock`);

		await manager.appendMessage(userMessage("retry", 2));
		expect(manager.messages).toEqual([userMessage("retry", 2)]);
		expect(manager.entries[0]?.id).toBe("entry-2");
	});

	it("isolates header, entries, messages, and diagnostics snapshots", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1"),
		});
		await manager.appendMessage(userMessage("original", 1));

		(manager.header as { cwd: string }).cwd = "C:\\mutated";
		const entries = manager.entries;
		const firstEntry = entries[0];
		if (firstEntry?.type !== "message") throw new Error("Expected a message entry.");
		(firstEntry.message as Extract<Message, { role: "user" }>).content[0] = { type: "text", text: "entry mutation" };
		const messages = manager.messages;
		(messages[0] as Extract<Message, { role: "user" }>).content[0] = { type: "text", text: "message mutation" };

		expect(manager.header.cwd).toBe(resolve(root));
		expect(manager.messages).toEqual([userMessage("original", 1)]);
	});

	it("snapshots append input before queued asynchronous work begins", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1"),
		});
		const message = userMessage("original", 1);

		const appending = manager.appendMessage(message);
		(message as Extract<Message, { role: "user" }>).content[0] = { type: "text", text: "mutated" };
		await appending;

		expect(manager.messages).toEqual([userMessage("original", 1)]);
		expect((await SessionManager.open(sessionFile)).messages).toEqual([userMessage("original", 1)]);
	});

	it("appends a summary without removing original messages", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1", "summary-1"),
		});
		const kept = await manager.appendMessage(userMessage("kept", 1));

		const summary = await manager.appendSummary({
			summary: "Earlier work",
			firstKeptEntryId: kept.id,
			tokensBefore: 100,
		});

		expect(summary).toMatchObject({
			type: "summary",
			id: "summary-1",
			parentId: kept.id,
			firstKeptEntryId: kept.id,
			tokensBefore: 100,
		});
		expect(manager.entries.map((entry) => entry.type)).toEqual(["message", "summary"]);
		expect(manager.messages).toEqual([userMessage("kept", 1)]);
	});

	it("returns the latest summary when more than one exists", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1", "summary-1", "summary-2"),
		});
		const kept = await manager.appendMessage(userMessage("kept", 1));
		await manager.appendSummary({ summary: "first", firstKeptEntryId: kept.id, tokensBefore: 10 });
		await manager.appendSummary({ summary: "second", firstKeptEntryId: kept.id, tokensBefore: 20 });

		expect(manager.latestSummary).toMatchObject({ id: "summary-2", summary: "second" });
	});

	it("serializes message and summary appends through one queue", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1", "summary-1", "entry-2"),
		});
		const kept = await manager.appendMessage(userMessage("kept", 1));

		await Promise.all([
			manager.appendSummary({ summary: "summary", firstKeptEntryId: kept.id, tokensBefore: 10 }),
			manager.appendMessage(userMessage("after", 2)),
		]);

		expect(manager.entries.map(({ type, id, parentId }) => ({ type, id, parentId }))).toEqual([
			{ type: "message", id: "entry-1", parentId: "session-1" },
			{ type: "summary", id: "summary-1", parentId: "entry-1" },
			{ type: "message", id: "entry-2", parentId: "summary-1" },
		]);
	});

	it("isolates summary append input and getter snapshots", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			createId: idSequence("session-1", "entry-1", "summary-1"),
		});
		const kept = await manager.appendMessage(userMessage("kept", 1));
		const input = { summary: "original", firstKeptEntryId: kept.id, tokensBefore: 10 };

		const appending = manager.appendSummary(input);
		input.summary = "mutated";
		await appending;
		const latest = manager.latestSummary;
		if (latest) (latest as { summary: string }).summary = "snapshot mutation";

		expect(manager.latestSummary?.summary).toBe("original");
		expect((await SessionManager.open(sessionFile)).latestSummary?.summary).toBe("original");
	});
});
