import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Box } from "../src/components/box.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Spacer } from "../src/components/spacer.ts";
import { TruncatedText } from "../src/components/truncated-text.ts";
import type { Component } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

function stripSgr(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI assertions intentionally match ESC.
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

class FixedComponent implements Component {
	private readonly content: string[];

	constructor(content: string[]) {
		this.content = content;
	}

	render(width: number): string[] {
		return this.content.map((line) => line.slice(0, width));
	}

	invalidate(): void {}
}

describe("Markdown", () => {
	it("renders common blocks and inline ANSI styles", () => {
		const markdown = new Markdown(
			"# Title\n\n**bold** *italic* `code`\n\n- one\n- two\n\n> quote\n\n```\nconst x = 1;\n```\n\n---",
		);

		const lines = markdown.render(30);
		const plain = stripSgr(lines.join("\n"));

		assert.equal(plain.includes("Title"), true);
		assert.equal(plain.includes("• one"), true);
		assert.equal(plain.includes("│ quote"), true);
		assert.equal(plain.includes("const x = 1;"), true);
		assert.equal(lines.join("").includes("\x1b[1m"), true);
		assert.equal(lines.join("").includes("\x1b[3m"), true);
		assert.equal(lines.join("").includes("\x1b[2m"), true);
	});

	it("wraps ANSI text without exceeding narrow width", () => {
		const markdown = new Markdown("A **very long 世界 text** that wraps", { paddingX: 1 });

		const lines = markdown.render(10);

		assert.ok(lines.length > 1);
		assert.ok(lines.every((line) => visibleWidth(line) <= 10));
	});

	it("keeps incomplete inline and fenced syntax visible", () => {
		const markdown = new Markdown("literal **bold\n```ts\nconst value = 1;\n``");

		const plain = stripSgr(markdown.render(40).join("\n"));

		assert.equal(plain.includes("**bold"), true);
		assert.equal(plain.includes("const value = 1;"), true);
	});

	it("invalidates when text changes", () => {
		const markdown = new Markdown("old");
		assert.equal(markdown.render(20).join("").includes("old"), true);

		markdown.setText("new");

		assert.equal(markdown.render(20).join("").includes("new"), true);
		assert.equal(markdown.render(20).join("").includes("old"), false);
	});
});

describe("Box", () => {
	it("wraps child lines with a titled single border", () => {
		const box = new Box(new FixedComponent(["hello", "world"]), { title: "Info", padding: 1 });

		const lines = box.render(14);

		assert.equal(lines[0]?.startsWith("┌"), true);
		assert.equal(lines[0]?.includes("Info"), true);
		assert.equal(lines.at(-1)?.startsWith("└"), true);
		assert.ok(lines.every((line) => visibleWidth(line) <= 14));
	});

	it("supports double, rounded, and no border modes", () => {
		assert.equal(new Box(new FixedComponent(["x"]), { border: "double" }).render(8)[0]?.startsWith("╔"), true);
		assert.equal(new Box(new FixedComponent(["x"]), { border: "rounded" }).render(8)[0]?.startsWith("╭"), true);
		assert.deepEqual(new Box(new FixedComponent(["x"]), { border: "none" }).render(8), ["x"]);
	});

	it("stays within a narrow width", () => {
		const box = new Box(new FixedComponent(["中文内容"]), { padding: 1 });

		const lines = box.render(5);

		assert.ok(lines.every((line) => visibleWidth(line) <= 5));
		assert.ok(
			new Box(new FixedComponent(["x"]), { title: "Long title", padding: 1 })
				.render(3)
				.every((line) => visibleWidth(line) <= 3),
		);
	});

	it("clamps padding on a one-column terminal", () => {
		assert.ok(new Markdown("世界", { paddingX: 2 }).render(1).every((line) => visibleWidth(line) <= 1));
		assert.ok(new TruncatedText("世界", { paddingX: 2 }).render(1).every((line) => visibleWidth(line) <= 1));
	});
});

describe("Spacer", () => {
	it("renders a fixed number of empty rows", () => {
		assert.deepEqual(new Spacer(3).render(20), ["", "", ""]);
		assert.deepEqual(new Spacer().render(20), [""]);
	});

	it("rejects negative row counts", () => {
		assert.throws(() => new Spacer(-1), { message: "Spacer rows must be a non-negative integer" });
	});
});

describe("TruncatedText", () => {
	it("truncates and pads a single line", () => {
		const text = new TruncatedText("This is long", { paddingX: 1 });

		const [line = ""] = text.render(10);

		assert.equal(visibleWidth(line), 10);
		assert.equal(line.includes("..."), true);
	});

	it("preserves ANSI codes and ignores later lines", () => {
		const text = new TruncatedText("\x1b[31mred text\x1b[0m\nsecond", { ellipsis: "…" });

		const lines = text.render(20);

		assert.equal(lines.length, 1);
		assert.equal(lines[0]?.includes("\x1b[31m"), true);
		assert.equal(lines[0]?.includes("second"), false);
	});

	it("supports vertical padding and invalidation", () => {
		const text = new TruncatedText("old", { paddingY: 1 });
		assert.equal(text.render(12).length, 3);

		text.setText("new");

		assert.equal(text.render(12).join("").includes("new"), true);
	});
});
