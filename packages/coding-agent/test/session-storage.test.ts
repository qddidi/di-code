import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSessionEntry, createSessionFile, loadSessionFile } from "../src/core/session/session-storage.ts";
import {
	SESSION_FORMAT_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
	type SessionSummaryEntry,
} from "../src/core/session/types.ts";

const RECORD_TIME = "2026-08-12T13:00:00.000Z";

const userMessage: Message = {
	role: "user",
	content: [{ type: "text", text: "hello" }],
	timestamp: 1,
};

const assistantMessage: Message = {
	role: "assistant",
	content: [{ type: "text", text: "I will read it." }],
	provider: "faux",
	model: "faux-model",
	usage: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 2,
	stopReason: "tool_use",
};

const toolResultMessage: Message = {
	role: "tool_result",
	toolCallId: "read-1",
	toolName: "read",
	content: [{ type: "text", text: "file contents" }],
	isError: false,
	timestamp: 3,
};

function createHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
	return {
		type: "session",
		version: SESSION_FORMAT_VERSION,
		id: "session-1",
		parentId: null,
		timestamp: RECORD_TIME,
		cwd: "D:\\workspace",
		...overrides,
	};
}

function createEntry(id: string, parentId: string, message: Message): SessionMessageEntry {
	return {
		type: "message",
		version: SESSION_FORMAT_VERSION,
		id,
		parentId,
		timestamp: RECORD_TIME,
		message,
	};
}

function createSummary(
	id: string,
	parentId: string,
	firstKeptEntryId: string,
	overrides: Partial<SessionSummaryEntry> = {},
): SessionSummaryEntry {
	return {
		type: "summary",
		version: SESSION_FORMAT_VERSION,
		id,
		parentId,
		timestamp: RECORD_TIME,
		summary: "Earlier work summary",
		firstKeptEntryId,
		tokensBefore: 100,
		...overrides,
	};
}

async function writeRecords(
	filePath: string,
	records: readonly unknown[],
	options: { readonly finalNewline?: boolean; readonly eol?: "\n" | "\r\n" } = {},
): Promise<void> {
	const eol = options.eol ?? "\n";
	const finalNewline = options.finalNewline ?? true;
	const body = records.map((record) => JSON.stringify(record)).join(eol);
	await writeFile(filePath, `${body}${finalNewline ? eol : ""}`, "utf8");
}

describe("loadSessionFile", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-session-storage-"));
		sessionFile = join(root, "session.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("loads a complete linear session with every current message role", async () => {
		const records = [
			createHeader(),
			createEntry("entry-1", "session-1", userMessage),
			createEntry("entry-2", "entry-1", assistantMessage),
			createEntry("entry-3", "entry-2", toolResultMessage),
		];
		await writeRecords(sessionFile, records, { eol: "\r\n" });

		const loaded = await loadSessionFile(sessionFile);

		expect(loaded.header).toEqual(records[0]);
		expect(loaded.entries).toEqual(records.slice(1));
		expect(loaded.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("loads summary entries while preserving every original message", async () => {
		const first = createEntry("entry-1", "session-1", userMessage);
		const kept = createEntry("entry-2", "entry-1", assistantMessage);
		const summary = createSummary("summary-1", "entry-2", kept.id);
		await writeRecords(sessionFile, [createHeader(), first, kept, summary]);

		const loaded = await loadSessionFile(sessionFile);

		expect(loaded.entries).toEqual([first, kept, summary]);
		expect(loaded.messages).toEqual([userMessage, assistantMessage]);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("treats invalid summary fields as a corrupt record", async () => {
		const kept = createEntry("entry-1", "session-1", userMessage);
		const invalidSummaries = [
			{
				entry: createSummary("summary-1", kept.id, kept.id, { summary: "   " }),
				reason: "record summary must be a non-empty string",
			},
			{
				entry: createSummary("summary-1", kept.id, kept.id, { tokensBefore: -1 }),
				reason: "record tokensBefore must be a non-negative safe integer",
			},
			{
				entry: createSummary("summary-1", kept.id, kept.id, { tokensBefore: 1.5 }),
				reason: "record tokensBefore must be a non-negative safe integer",
			},
		];

		for (const { entry, reason } of invalidSummaries) {
			await writeRecords(sessionFile, [createHeader(), kept, entry]);
			const loaded = await loadSessionFile(sessionFile);
			expect(loaded.entries).toEqual([kept]);
			expect(loaded.diagnostics[0]).toMatchObject({ kind: "corrupt_record", lineNumber: 3, reason });
		}
	});

	it("rejects summary kept references to a missing, header, or summary record", async () => {
		const first = createEntry("entry-1", "session-1", userMessage);
		const firstSummary = createSummary("summary-1", first.id, first.id);
		const cases = [
			[createHeader(), first, createSummary("summary-1", first.id, "missing")],
			[createHeader(), first, createSummary("summary-1", first.id, "session-1")],
			[createHeader(), first, firstSummary, createSummary("summary-2", firstSummary.id, firstSummary.id)],
		];

		for (const records of cases) {
			await writeRecords(sessionFile, records);
			const loaded = await loadSessionFile(sessionFile);
			expect(loaded.diagnostics[0]).toMatchObject({
				kind: "corrupt_record",
				reason: "record firstKeptEntryId must reference an earlier message entry",
			});
		}
	});

	it("continues the linear parent chain with messages after a summary", async () => {
		const first = createEntry("entry-1", "session-1", userMessage);
		const summary = createSummary("summary-1", first.id, first.id);
		const next = createEntry("entry-2", summary.id, assistantMessage);
		await writeRecords(sessionFile, [createHeader(), first, summary, next]);

		const loaded = await loadSessionFile(sessionFile);

		expect(loaded.entries).toEqual([first, summary, next]);
		expect(loaded.messages).toEqual([userMessage, assistantMessage]);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("rejects an empty file, a non-session record, and a relative cwd as headers", async () => {
		await writeFile(sessionFile, "", "utf8");
		await expect(loadSessionFile(sessionFile)).rejects.toMatchObject({
			name: "SessionLoadError",
			code: "INVALID_HEADER",
			lineNumber: 1,
		});

		await writeRecords(sessionFile, [createEntry("entry-1", "session-1", userMessage)]);
		await expect(loadSessionFile(sessionFile)).rejects.toMatchObject({
			code: "INVALID_HEADER",
			lineNumber: 1,
		});

		await writeRecords(sessionFile, [{ ...createHeader(), cwd: "relative/path" }]);
		await expect(loadSessionFile(sessionFile)).rejects.toMatchObject({
			code: "INVALID_HEADER",
			lineNumber: 1,
		});
	});

	it("rejects older and newer unsupported header versions", async () => {
		for (const version of [0, 2]) {
			await writeRecords(sessionFile, [{ ...createHeader(), version }]);
			await expect(loadSessionFile(sessionFile)).rejects.toMatchObject({
				name: "SessionLoadError",
				code: "UNSUPPORTED_VERSION",
				lineNumber: 1,
			});
		}
	});

	it("ignores a final line without a newline and reports it as uncommitted", async () => {
		await writeFile(
			sessionFile,
			`${JSON.stringify(createHeader())}\n${JSON.stringify(createEntry("entry-1", "session-1", userMessage))}`,
			"utf8",
		);

		const loaded = await loadSessionFile(sessionFile);

		expect(loaded.entries).toEqual([]);
		expect(loaded.diagnostics).toEqual([
			{
				kind: "trailing_partial_line",
				lineNumber: 2,
				reason: "final line has no newline commit marker",
			},
		]);
	});

	it("stops at malformed JSON and does not trust a valid-looking suffix", async () => {
		const validPrefix = createEntry("entry-1", "session-1", userMessage);
		const suffix = createEntry("entry-3", "entry-2", toolResultMessage);
		await writeFile(
			sessionFile,
			`${JSON.stringify(createHeader())}\n${JSON.stringify(validPrefix)}\n{"type":\n${JSON.stringify(suffix)}\n`,
			"utf8",
		);

		const loaded = await loadSessionFile(sessionFile);

		expect(loaded.entries).toEqual([validPrefix]);
		expect(loaded.diagnostics).toHaveLength(1);
		expect(loaded.diagnostics[0]).toMatchObject({ kind: "corrupt_record", lineNumber: 3 });
	});

	it("treats parseable records with invalid nested messages as corrupt", async () => {
		const invalidMessages = [
			{ ...userMessage, timestamp: "not-a-number" },
			{ ...assistantMessage, usage: { ...assistantMessage.usage, output: -1 } },
			{ ...assistantMessage, stopReason: "stop", errorMessage: "success must not carry an error" },
			{ ...assistantMessage, stopReason: "error" },
			{ ...toolResultMessage, isError: "false" },
		];

		for (const message of invalidMessages) {
			const invalidEntry = { ...createEntry("entry-1", "session-1", userMessage), message };
			await writeRecords(sessionFile, [createHeader(), invalidEntry]);
			const loaded = await loadSessionFile(sessionFile);

			expect(loaded.entries).toEqual([]);
			expect(loaded.diagnostics[0]).toMatchObject({
				kind: "corrupt_record",
				lineNumber: 2,
				reason: "record message does not match the Message contract",
			});
		}
	});

	it("stops when an entry duplicates an id or does not extend the current leaf", async () => {
		const first = createEntry("entry-1", "session-1", userMessage);
		const cases = [
			{
				records: [createHeader(), first, createEntry("entry-1", "entry-1", assistantMessage)],
				reason: "record id is duplicated",
				lineNumber: 3,
			},
			{
				records: [createHeader(), createEntry("entry-1", "missing-parent", userMessage)],
				reason: 'record parentId must be "session-1"',
				lineNumber: 2,
			},
		];

		for (const scenario of cases) {
			await writeRecords(sessionFile, scenario.records);
			const loaded = await loadSessionFile(sessionFile);
			expect(loaded.diagnostics[0]).toMatchObject({
				kind: "corrupt_record",
				lineNumber: scenario.lineNumber,
				reason: scenario.reason,
			});
		}
	});

	it("wraps file read failures without hiding the original cause", async () => {
		const missingFile = join(root, "missing.jsonl");

		try {
			await loadSessionFile(missingFile);
			throw new Error("Expected loadSessionFile to fail.");
		} catch (cause) {
			expect(cause).toMatchObject({
				name: "SessionLoadError",
				code: "READ_FAILED",
				filePath: missingFile,
			});
			expect(cause).toBeInstanceOf(Error);
			if (!(cause instanceof Error)) throw cause;
			expect(cause.cause).toBeInstanceOf(Error);
		}
	});

	it("creates a committed header without overwriting an existing session", async () => {
		const header = createHeader();
		await createSessionFile(sessionFile, header);
		const original = await readFile(sessionFile, "utf8");

		expect(original).toBe(`${JSON.stringify(header)}\n`);
		await expect(createSessionFile(sessionFile, { ...header, id: "session-2" })).rejects.toMatchObject({
			name: "SessionWriteError",
			code: "CREATE_FAILED",
		});
		expect(await readFile(sessionFile, "utf8")).toBe(original);
	});

	it("appends one committed entry that can be loaded again", async () => {
		const header = createHeader();
		const entry = createEntry("entry-1", header.id, userMessage);
		await createSessionFile(sessionFile, header);

		await appendSessionEntry(sessionFile, entry, header.id);

		const loaded = await loadSessionFile(sessionFile);
		expect(loaded.entries).toEqual([entry]);
		expect(await readFile(sessionFile, "utf8")).toBe(`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
	});

	it("rejects a stale expected parent without changing file bytes", async () => {
		const header = createHeader();
		const first = createEntry("entry-1", header.id, userMessage);
		await writeRecords(sessionFile, [header, first]);
		const before = await readFile(sessionFile);

		await expect(
			appendSessionEntry(sessionFile, createEntry("entry-2", header.id, assistantMessage), header.id),
		).rejects.toMatchObject({
			name: "SessionWriteError",
			code: "CONCURRENT_MODIFICATION",
			expectedParentId: header.id,
			actualParentId: first.id,
		});
		expect(await readFile(sessionFile)).toEqual(before);
	});

	it("refuses to append when the loaded session contains a recovery diagnostic", async () => {
		const header = createHeader();
		await writeFile(sessionFile, `${JSON.stringify(header)}\n{"type":\n`, "utf8");

		await expect(
			appendSessionEntry(sessionFile, createEntry("entry-1", header.id, userMessage), header.id),
		).rejects.toMatchObject({
			name: "SessionWriteError",
			code: "CORRUPT_SESSION",
		});

		await writeFile(sessionFile, "not-json\n", "utf8");
		await expect(
			appendSessionEntry(sessionFile, createEntry("entry-1", header.id, userMessage), header.id),
		).rejects.toMatchObject({
			name: "SessionWriteError",
			code: "CORRUPT_SESSION",
		});

		await rm(sessionFile);
		await expect(
			appendSessionEntry(sessionFile, createEntry("entry-1", header.id, userMessage), header.id),
		).rejects.toMatchObject({
			name: "SessionWriteError",
			code: "APPEND_FAILED",
		});
	});

	it("times out while another writer owns the lock", async () => {
		const header = createHeader();
		await createSessionFile(sessionFile, header);
		await writeFile(`${sessionFile}.lock`, "held", "utf8");
		let clock = 0;

		await expect(
			appendSessionEntry(sessionFile, createEntry("entry-1", header.id, userMessage), header.id, {
				lockTimeoutMs: 2,
				lockRetryMs: 1,
				now: () => clock,
				sleep: async () => {
					clock++;
				},
			}),
		).rejects.toMatchObject({
			name: "SessionWriteError",
			code: "LOCK_TIMEOUT",
		});
	});

	it("rejects invalid new records and duplicate ids before writing bytes", async () => {
		const header = createHeader();
		const first = createEntry("entry-1", header.id, userMessage);
		await writeRecords(sessionFile, [header, first]);
		const before = await readFile(sessionFile);

		await expect(
			appendSessionEntry(sessionFile, { ...first, id: "bad id", parentId: first.id }, first.id),
		).rejects.toMatchObject({ code: "APPEND_FAILED" });
		await expect(appendSessionEntry(sessionFile, { ...first, parentId: first.id }, first.id)).rejects.toMatchObject({
			code: "APPEND_FAILED",
		});
		expect(await readFile(sessionFile)).toEqual(before);
	});

	it("writes immutable snapshots when caller objects change across async boundaries", async () => {
		const header = createHeader();
		const creating = createSessionFile(sessionFile, header);
		(header as { cwd: string }).cwd = "C:\\mutated";
		await creating;
		expect((await loadSessionFile(sessionFile)).header.cwd).toBe("D:\\workspace");

		const expectedMessage = structuredClone(userMessage);
		const entry = createEntry("entry-1", "session-1", structuredClone(expectedMessage));
		await writeFile(`${sessionFile}.lock`, "held", "utf8");
		let releaseWait: (() => void) | undefined;
		const appending = appendSessionEntry(sessionFile, entry, "session-1", {
			lockTimeoutMs: 100,
			lockRetryMs: 1,
			sleep: async () => {
				await new Promise<void>((resolve) => {
					releaseWait = resolve;
				});
			},
		});
		await Promise.resolve();
		(entry.message as Extract<Message, { role: "user" }>).content[0] = { type: "text", text: "mutated" };
		await rm(`${sessionFile}.lock`);
		releaseWait?.();
		await appending;

		expect((await loadSessionFile(sessionFile)).messages).toEqual([expectedMessage]);
	});
});
