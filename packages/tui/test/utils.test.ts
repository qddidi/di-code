import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../src/utils.ts";

describe("visibleWidth", () => {
	it("returns zero for an empty string", () => {
		assert.equal(visibleWidth(""), 0);
	});

	it("counts ASCII columns", () => {
		assert.equal(visibleWidth("hello"), 5);
	});

	it("counts CJK as two columns", () => {
		assert.equal(visibleWidth("A界B"), 4);
	});

	it("counts an emoji grapheme as two columns", () => {
		assert.equal(visibleWidth("A🙂B"), 4);
	});

	it("does not count combining marks separately", () => {
		assert.equal(visibleWidth("e\u0301"), 1);
	});

	it("does not count CSI styling", () => {
		assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
	});

	it("does not count an OSC hyperlink", () => {
		assert.equal(visibleWidth("\x1b]8;;https://example.test\x07link\x1b]8;;\x07"), 4);
	});

	it("uses a deterministic three-column tab", () => {
		assert.equal(visibleWidth("a\tb"), 5);
	});

	it("counts an isolated regional indicator conservatively", () => {
		assert.equal(visibleWidth("🇨"), 2);
	});
});

describe("truncateToWidth", () => {
	it("returns an empty string for a non-positive width", () => {
		assert.equal(truncateToWidth("abc", 0), "");
	});

	it("keeps a grapheme intact", () => {
		assert.equal(truncateToWidth("A🙂B", 2, ""), "A\x1b[0m");
	});

	it("keeps a wide CJK character only when both columns fit", () => {
		assert.equal(truncateToWidth("界B", 2, ""), "界\x1b[0m");
		assert.equal(truncateToWidth("界B", 1, ""), "\x1b[0m");
	});

	it("adds an ellipsis without exceeding the limit", () => {
		const result = truncateToWidth("abcdef", 4, "…");
		assert.equal(result, "abc\x1b[0m…\x1b[0m");
		assert.ok(visibleWidth(result) <= 4);
	});

	it("resets ANSI style before the ellipsis", () => {
		const result = truncateToWidth("\x1b[31mabcdef", 4, "…");
		assert.equal(result, "\x1b[31mabc\x1b[0m…\x1b[0m");
	});

	it("pads a truncated result to the requested width", () => {
		const result = truncateToWidth("abcdef", 4, "…", true);
		assert.equal(visibleWidth(result), 4);
	});
});

describe("sliceByColumn", () => {
	it("returns an empty string for a non-positive length", () => {
		assert.equal(sliceByColumn("abc", 0, 0), "");
	});

	it("slices by visible columns, not UTF-16 indexes", () => {
		assert.equal(sliceByColumn("A界B", 1, 2), "界\x1b[0m");
	});

	it("does not split an emoji grapheme", () => {
		assert.equal(sliceByColumn("A🙂B", 1, 1), "");
		assert.equal(sliceByColumn("A🙂B", 1, 2), "🙂\x1b[0m");
	});

	it("preserves ANSI codes needed by the selected range", () => {
		const result = sliceByColumn("\x1b[31mred\x1b[0m!", 0, 2);
		assert.equal(result, "\x1b[31mre\x1b[0m");
	});
});
