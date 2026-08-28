import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Input } from "../src/components/input.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

describe("Input editing", () => {
	it("inserts printable text and reports changes", () => {
		const input = new Input();
		const changes: string[] = [];
		input.onChange = (value) => changes.push(value);
		input.handleInput("你");
		input.handleInput("a");

		assert.equal(input.getValue(), "你a");
		assert.deepEqual(changes, ["你", "你a"]);
	});

	it("moves and deletes by grapheme rather than UTF-16 code units", () => {
		const input = new Input();
		input.setValue("A👨‍👩‍👧‍👦B");
		input.handleInput("\x1b[D");
		input.handleInput("\x7f");

		assert.equal(input.getValue(), "AB");
	});

	it("supports Home, End, forward Delete, and Backspace", () => {
		const input = new Input();
		input.setValue("abc");
		input.handleInput("\x01");
		input.handleInput("\x1b[3~");
		input.handleInput("\x05");
		input.handleInput("\x7f");

		assert.equal(input.getValue(), "b");
	});

	it("buffers bracketed paste and normalizes it to one line", () => {
		const input = new Input();
		input.handleInput("\x1b[200~hello\r\n");
		assert.equal(input.getValue(), "");
		input.handleInput("world\x1b[201~");

		assert.equal(input.getValue(), "hello world");
	});

	it("accepts an unbracketed Windows multiline paste", () => {
		const input = new Input();

		input.handleInput("hello\r\nworld");

		assert.equal(input.getValue(), "hello world");
	});

	it("submits on Enter and cancels on Escape without changing text", () => {
		const input = new Input();
		const submitted: string[] = [];
		let escapes = 0;
		input.setValue("answer");
		input.onSubmit = (value) => submitted.push(value);
		input.onEscape = () => {
			escapes += 1;
		};
		input.handleInput("\r");
		input.handleInput("\x1b");

		assert.deepEqual(submitted, ["answer"]);
		assert.equal(escapes, 1);
		assert.equal(input.getValue(), "answer");
	});

	it("masks the rendered value while preserving the submitted secret", () => {
		const input = new Input({ mask: "*" });
		const submitted: string[] = [];
		input.onSubmit = (value) => submitted.push(value);
		input.focused = true;
		input.handleInput("secret-key");

		const rendered = input.render(32).join("\n");
		input.handleInput("\r");

		assert.equal(input.getValue(), "secret-key");
		assert.deepEqual(submitted, ["secret-key"]);
		assert.equal(rendered.includes("secret-key"), false);
		assert.equal(rendered.includes("**********"), true);
	});

	it("rejects a multi-column mask", () => {
		assert.throws(() => new Input({ mask: "界" }), /one visible column/);
	});

	it("can treat Ctrl-D as end-of-input cancellation", () => {
		const input = new Input({ cancelOnEndOfTransmission: true });
		let cancellations = 0;
		input.onEscape = () => {
			cancellations += 1;
		};

		input.handleInput("\x04");

		assert.equal(cancellations, 1);
	});
});

describe("Input rendering", () => {
	it("emits a zero-width cursor marker only while focused", () => {
		const input = new Input();
		input.setValue("abc");
		assert.equal(input.render(5)[0].includes(CURSOR_MARKER), false);

		input.focused = true;
		const line = input.render(5)[0];
		assert.equal(line.includes(CURSOR_MARKER), true);
		assert.equal(visibleWidth(line), 5);
	});

	it("scrolls horizontally to keep the cursor visible on narrow screens", () => {
		const input = new Input();
		input.focused = true;
		input.setValue("abcdef");
		const line = input.render(4)[0];

		assert.equal(visibleWidth(line), 4);
		assert.equal(line.includes("def"), true);
	});

	it("keeps CJK and emoji rendering within one column", () => {
		const input = new Input();
		input.focused = true;
		input.setValue("界🙂");
		const line = input.render(1)[0];

		assert.equal(visibleWidth(line), 1);
		assert.equal(line.includes(CURSOR_MARKER), true);
	});
});
