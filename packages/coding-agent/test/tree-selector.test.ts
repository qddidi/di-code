import { visibleWidth } from "@di-code/tui";
import { describe, expect, it } from "vitest";
import type { SessionMessageEntry } from "../src/core/session/types.ts";
import { TreeSelector } from "../src/modes/tree-selector.ts";

function plainText(value: string): string {
	return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function userEntry(id: string, parentId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		version: 2,
		id,
		parentId,
		timestamp: "2026-08-19T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	};
}

describe("TreeSelector", () => {
	it("renders a compact Pi-style branch tree and keeps every line within narrow terminal bounds", () => {
		const root = userEntry("root", "session", "original question");
		const branch = userEntry("branch", "root", "a branch with a deliberately long\npreview line");
		const sibling = userEntry("sibling", "root", "a sibling branch");
		const selector = new TreeSelector({
			nodes: [
				{
					entry: root,
					children: [
						{ entry: branch, children: [] },
						{ entry: sibling, children: [] },
					],
				},
			],
			leafId: "branch",
			locale: "en",
		});

		const wideLines = selector.render(90);
		const wide = plainText(wideLines.join("\n"));
		expect(wide).toContain("├─");
		expect(wide).toContain("└─");
		expect(wide).toContain("›");
		expect(wide).toContain("•");
		expect(wide).toContain("user: original question");
		expect(wide).toContain("user: a branch");
		expect(wide).toContain("(2/3)");
		expect(wide).toContain("Summarize + branch");
		expect(wide).not.toContain("Preview");
		expect(wideLines.every((line) => !line.includes("\n"))).toBe(true);
		expect(visibleWidth(wideLines[1] ?? "")).toBe(90);

		const narrow = selector.render(40);
		expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it("routes enter, edit, summarize, and cancel from the selected node", () => {
		const first = userEntry("first", "session", "first");
		const second = userEntry("second", "first", "second");
		const calls: string[] = [];
		const selector = new TreeSelector({
			nodes: [{ entry: first, children: [{ entry: second, children: [] }] }],
			leafId: "second",
			locale: "en",
			onContinue: (entry) => calls.push(`continue:${entry.id}`),
			onEdit: (entry) => calls.push(`edit:${entry.id}`),
			onSummarize: (entry) => calls.push(`summarize:${entry.id}`),
			onCancel: () => calls.push("cancel"),
		});

		selector.handleInput("\r");
		selector.handleInput("e");
		selector.handleInput("s");
		selector.handleInput("\x1b");

		expect(calls).toEqual(["continue:second", "edit:second", "summarize:second", "cancel"]);
	});

	it("keeps a linear conversation aligned until the session actually branches", () => {
		const root = userEntry("root", "session", "root");
		const reply = userEntry("reply", "root", "reply");
		const followUp = userEntry("follow-up", "reply", "follow up");
		const selector = new TreeSelector({
			nodes: [
				{
					entry: root,
					children: [{ entry: reply, children: [{ entry: followUp, children: [] }] }],
				},
			],
			leafId: "follow-up",
			locale: "en",
		});

		const lines = selector
			.render(80)
			.map(plainText)
			.filter((line) => line.includes("user:"));
		expect(lines).toEqual([
			expect.stringContaining("  • user: root"),
			expect.stringContaining("  • user: reply"),
			expect.stringContaining("› • user: follow up"),
		]);
		expect(lines.join("\n")).not.toContain("├─");
		expect(lines.join("\n")).not.toContain("└─");
	});
});
