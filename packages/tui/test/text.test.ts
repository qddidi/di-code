import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Text } from "../src/components/text.ts";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("wrapTextWithAnsi", () => {
	it("preserves hard line breaks and wraps ASCII", () => {
		assert.deepEqual(wrapTextWithAnsi("abcd\nef", 2), ["ab", "cd", "ef"]);
	});

	it("keeps CJK and emoji graphemes intact", () => {
		assert.deepEqual(wrapTextWithAnsi("A界🙂B", 3), ["A界", "🙂B"]);
	});

	it("closes and reapplies an active SGR style across wrapped lines", () => {
		assert.deepEqual(wrapTextWithAnsi("\x1b[31mabcd\x1b[0m", 2), ["\x1b[31mab\x1b[0m", "\x1b[31mcd\x1b[0m"]);
	});

	it("returns one empty line for empty input", () => {
		assert.deepEqual(wrapTextWithAnsi("", 4), [""]);
	});
});

describe("Text", () => {
	it("renders empty text as no lines", () => {
		assert.deepEqual(new Text().render(10), []);
	});

	it("wraps content inside horizontal and vertical padding", () => {
		const text = new Text("abcd", 1, 1);
		assert.deepEqual(text.render(4), ["    ", " ab ", " cd ", "    "]);
	});

	it("never exceeds a narrow viewport with CJK and emoji", () => {
		const lines = new Text("界🙂A").render(1);
		assert.deepEqual(lines, [" ", " ", "A"]);
		assert.ok(lines.every((line) => visibleWidth(line) <= 1));
	});

	it("caches by width and invalidates after text changes", () => {
		const text = new Text("first");
		const first = text.render(10);
		assert.equal(text.render(10), first);

		text.setText("second");
		const second = text.render(10);
		assert.notEqual(second, first);
		assert.deepEqual(second, ["second    "]);
	});

	it("rejects invalid padding at the public boundary", () => {
		assert.throws(() => new Text("value", -1, 0), { message: "Text padding must be non-negative integers" });
		assert.throws(() => new Text("value", 0, 1.5), { message: "Text padding must be non-negative integers" });
	});
});
