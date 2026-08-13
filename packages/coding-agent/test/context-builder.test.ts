import type { Message } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import { buildSessionContext } from "../src/core/context-builder.ts";
import type { SessionEntry, SessionMessageEntry, SessionSummaryEntry } from "../src/core/session/types.ts";

const timestamp = "2026-08-12T00:00:00.000Z";

function messageEntry(id: string, parentId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		version: 1,
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.parse(timestamp),
		},
	};
}

function summaryEntry(id: string, parentId: string, summary: string, firstKeptEntryId: string): SessionSummaryEntry {
	return {
		type: "summary",
		version: 1,
		id,
		parentId,
		timestamp,
		summary,
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

function textOf(message: Message): string {
	const block = message.content[0];
	if (!block || block.type !== "text") throw new Error("Expected a text message");
	return block.text;
}

describe("buildSessionContext", () => {
	it("projects every message and source id when there is no summary", () => {
		const entries: SessionEntry[] = [messageEntry("m1", "header", "one"), messageEntry("m2", "m1", "two")];

		const context = buildSessionContext(entries);

		expect(context.messages.map(textOf)).toEqual(["one", "two"]);
		expect(context.sourceEntryIds).toEqual(["m1", "m2"]);
	});

	it("projects the latest summary followed by messages from its kept boundary", () => {
		const entries: SessionEntry[] = [
			messageEntry("m1", "header", "discarded"),
			messageEntry("m2", "m1", "kept before summary"),
			summaryEntry("s1", "m2", "Earlier work is complete.", "m2"),
			messageEntry("m3", "s1", "after summary"),
		];

		const context = buildSessionContext(entries);

		expect(context.messages.map(textOf)).toEqual([
			"<conversation-summary>\nEarlier work is complete.\n</conversation-summary>",
			"kept before summary",
			"after summary",
		]);
		expect(context.messages[0]).toMatchObject({ role: "user", timestamp: Date.parse(timestamp) });
		expect(context.sourceEntryIds).toEqual([null, "m2", "m3"]);
	});

	it("uses only the latest summary during repeated compaction", () => {
		const entries: SessionEntry[] = [
			messageEntry("m1", "header", "old"),
			messageEntry("m2", "m1", "first kept"),
			summaryEntry("s1", "m2", "first summary", "m2"),
			messageEntry("m3", "s1", "latest kept"),
			summaryEntry("s2", "m3", "second summary", "m3"),
			messageEntry("m4", "s2", "new"),
		];

		const context = buildSessionContext(entries);

		expect(context.messages.map(textOf)).toEqual([
			"<conversation-summary>\nsecond summary\n</conversation-summary>",
			"latest kept",
			"new",
		]);
		expect(context.sourceEntryIds).toEqual([null, "m3", "m4"]);
	});

	it("deeply isolates returned messages from the input entries", () => {
		const entries: SessionEntry[] = [messageEntry("m1", "header", "original")];

		const context = buildSessionContext(entries);
		const returnedBlock = context.messages[0]?.content[0];
		if (returnedBlock?.type === "text") returnedBlock.text = "changed outside";
		expect(entries[0]?.type === "message" ? textOf(entries[0].message) : undefined).toBe("original");

		const secondContext = buildSessionContext(entries);
		const inputBlock = entries[0]?.type === "message" ? entries[0].message.content[0] : undefined;
		if (inputBlock?.type === "text") inputBlock.text = "changed input";

		expect(secondContext.messages.map(textOf)).toEqual(["original"]);
		expect(textOf(context.messages[0] as Message)).toBe("changed outside");
	});

	it.each([
		{
			name: "is missing",
			entries: [messageEntry("m1", "header", "one"), summaryEntry("s1", "m1", "summary", "missing")],
		},
		{
			name: "identifies another summary",
			entries: [
				messageEntry("m1", "header", "one"),
				summaryEntry("s1", "m1", "first", "m1"),
				summaryEntry("s2", "s1", "second", "s1"),
			],
		},
		{
			name: "identifies a future message",
			entries: [
				messageEntry("m1", "header", "one"),
				summaryEntry("s1", "m1", "summary", "m2"),
				messageEntry("m2", "s1", "future"),
			],
		},
	])("rejects a firstKeptEntryId that $name", ({ entries }) => {
		expect(() => buildSessionContext(entries)).toThrow(
			"Summary firstKeptEntryId must reference an earlier message entry.",
		);
	});
});
