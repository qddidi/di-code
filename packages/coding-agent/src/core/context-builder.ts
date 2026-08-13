import type { Message, UserMessage } from "@di-code/ai";
import type { SessionEntry, SessionMessageEntry, SessionSummaryEntry } from "./session/types.ts";

export interface BuiltSessionContext {
	readonly messages: readonly Message[];
	readonly sourceEntryIds: readonly (string | null)[];
}

function createSummaryMessage(entry: SessionSummaryEntry): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `<conversation-summary>\n${entry.summary}\n</conversation-summary>`,
			},
		],
		timestamp: Date.parse(entry.timestamp),
	};
}

function messageEntries(entries: readonly SessionEntry[]): SessionMessageEntry[] {
	return entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

export function buildSessionContext(entries: readonly SessionEntry[]): BuiltSessionContext {
	const snapshot = structuredClone([...entries]);
	let summaryIndex = -1;
	for (let index = snapshot.length - 1; index >= 0; index--) {
		if (snapshot[index]?.type === "summary") {
			summaryIndex = index;
			break;
		}
	}

	if (summaryIndex < 0) {
		const messages = messageEntries(snapshot);
		return {
			messages: messages.map((entry) => entry.message),
			sourceEntryIds: messages.map((entry) => entry.id),
		};
	}

	const summary = snapshot[summaryIndex];
	if (summary?.type !== "summary") {
		throw new Error("Latest summary entry could not be resolved.");
	}
	const firstKeptIndex = snapshot.findIndex(
		(entry, index) => index < summaryIndex && entry.type === "message" && entry.id === summary.firstKeptEntryId,
	);
	if (firstKeptIndex < 0) {
		throw new Error("Summary firstKeptEntryId must reference an earlier message entry.");
	}

	const keptEntries = messageEntries(snapshot.slice(firstKeptIndex));
	return {
		messages: [createSummaryMessage(summary), ...keptEntries.map((entry) => entry.message)],
		sourceEntryIds: [null, ...keptEntries.map((entry) => entry.id)],
	};
}
