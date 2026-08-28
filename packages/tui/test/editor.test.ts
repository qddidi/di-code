import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Editor } from "../src/components/editor.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

describe("Editor editing", () => {
	it("lets the owner consume commands and interrupts", () => {
		const editor = new Editor();
		const commands: string[] = [];
		let interrupted = false;
		editor.onCommand = (data) => {
			commands.push(data);
			return data === "\x0f";
		};
		editor.onInterrupt = () => {
			interrupted = true;
		};
		editor.handleInput("\x0f");
		editor.handleInput("\x03");
		assert.deepEqual(commands, ["\x0f", "\x03"]);
		assert.equal(interrupted, true);
	});
	it("inserts text, newlines, and reports changes", () => {
		const editor = new Editor();
		const changes: string[] = [];
		editor.onChange = (value) => changes.push(value);
		editor.handleInput("hello");
		editor.handleInput("\r");
		editor.handleInput("world");

		assert.equal(editor.getValue(), "hello\nworld");
		assert.deepEqual(changes.at(-1), "hello\nworld");
	});

	it("moves vertically while preserving the preferred column", () => {
		const editor = new Editor();
		editor.setValue("abcd\nxy\nzabcd");
		editor.handleInput("\x1b[A");

		assert.equal(editor.getCursorPosition().line, 1);
		assert.equal(editor.getCursorPosition().column, 2);
		editor.handleInput("\x1b[A");
		assert.equal(editor.getCursorPosition().line, 0);
		assert.equal(editor.getCursorPosition().column, 4);
	});

	it("deletes graphemes backward and forward", () => {
		const editor = new Editor();
		editor.setValue("A👨‍👩‍👧‍👦B");
		editor.handleInput("\x1b[F");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x7f");
		editor.handleInput("\x1b[3~");

		assert.equal(editor.getValue(), "A");
	});

	it("deletes from the cursor to the start of the line with Ctrl+U", () => {
		const editor = new Editor();
		editor.setValue("keep\nremove this");
		editor.handleInput("\x15");

		assert.equal(editor.getValue(), "keep\n");
	});

	it("submits on Enter when enabled and cancels on Escape", () => {
		const editor = new Editor();
		const submitted: string[] = [];
		let escapes = 0;
		editor.setValue("done");
		editor.onSubmit = (value) => submitted.push(value);
		editor.onEscape = () => {
			escapes += 1;
		};
		editor.handleInput("\r");
		editor.handleInput("\x1b");

		assert.deepEqual(submitted, ["done"]);
		assert.equal(escapes, 1);

		editor.disableSubmit = true;
		editor.handleInput("\r");
		assert.deepEqual(submitted, ["done"]);
	});

	it("preserves newlines in bracketed paste and rejects control bytes", () => {
		const editor = new Editor();
		editor.handleInput("\x1b[200~hello\r\n");
		assert.equal(editor.getValue(), "");
		editor.handleInput("world\x00\x1b[201~");

		assert.equal(editor.getValue(), "hello\nworld");
	});

	it("preserves newlines from an unbracketed Windows multiline paste", () => {
		const editor = new Editor();
		const changes: string[] = [];
		editor.onChange = (value) => changes.push(value);

		editor.handleInput("hello\r\nworld");

		assert.equal(editor.getValue(), "hello\nworld");
		assert.equal(changes.length, 1);
	});

	it("lets the owner transform bracketed paste before insertion", () => {
		const editor = new Editor();
		editor.onPaste = (text) => (text === "C:\\work\\diagram.png" ? '@"C:\\work\\diagram.png" ' : text);

		editor.handleInput("\x1b[200~C:\\work\\diagram.png\x1b[201~");

		assert.equal(editor.getValue(), '@"C:\\work\\diagram.png" ');
	});

	it("inserts programmatic text at the current cursor position", () => {
		const editor = new Editor();
		editor.setValue("ask now");
		editor.handleInput("\x1b[D");
		editor.insertTextAtCursor("C:\\Temp\\image.png ");

		assert.equal(editor.getValue(), "ask noC:\\Temp\\image.png w");
	});

	it("preserves a preferred visible column across Unicode lines", () => {
		const editor = new Editor();
		editor.setValue("界A\nx\n界A");
		editor.handleInput("\x1b[A");
		assert.deepEqual(editor.getCursorPosition(), { line: 1, column: 1 });
		editor.handleInput("\x1b[A");
		assert.deepEqual(editor.getCursorPosition(), { line: 0, column: 3 });
	});
});

describe("Editor rendering", () => {
	it("rejects an invalid maximum height", () => {
		assert.throws(() => new Editor({ maxHeight: 0 }), { message: "Editor maxHeight must be a positive integer" });
	});

	it("wraps long lines and emits one focused cursor marker", () => {
		const editor = new Editor();
		editor.focused = true;
		editor.setValue("abcdef");
		const lines = editor.render(3);

		assert.deepEqual(
			lines.map((line) => visibleWidth(line)),
			[3, 3, 3],
		);
		assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
	});

	it("draws an inverse software cursor while preserving the hardware cursor marker", () => {
		const emptyEditor = new Editor();
		emptyEditor.focused = true;
		assert.equal(emptyEditor.render(4)[0].includes("\x1b[7m \x1b[0m"), true);

		const editor = new Editor();
		editor.focused = true;
		editor.setValue("abc");
		editor.handleInput("\x1b[D");
		const rendered = editor.render(8).join("");
		assert.equal(rendered.includes(CURSOR_MARKER), true);
		assert.equal(rendered.includes("\x1b[7mc\x1b[0m"), true);
	});

	it("keeps CJK and emoji within a narrow width", () => {
		const editor = new Editor();
		editor.focused = true;
		editor.setValue("界🙂A");
		const lines = editor.render(2);

		assert.ok(lines.every((line) => visibleWidth(line) <= 2));
		assert.equal(lines.join("").includes(CURSOR_MARKER), true);
	});

	it("invalidates its cached layout after content changes", () => {
		const editor = new Editor();
		editor.setValue("one");
		const first = editor.render(10);
		editor.setValue("two");
		const second = editor.render(10);

		assert.notEqual(second, first);
		assert.equal(second.join(""), "two       ");
	});

	it("updates the cursor marker when focus changes without changing text", () => {
		const editor = new Editor();
		editor.setValue("abc");
		assert.equal(editor.render(5)[0].includes(CURSOR_MARKER), false);
		editor.focused = true;
		assert.equal(editor.render(5)[0].includes(CURSOR_MARKER), true);
	});

	it("keeps the focused cursor inside a bounded viewport", () => {
		const editor = new Editor({ maxHeight: 2 });
		editor.focused = true;
		editor.setValue("one\ntwo\nthree");
		const lines = editor.render(10);

		assert.equal(lines.length, 2);
		assert.equal(
			lines.some((line) => line.includes("one")),
			false,
		);
		assert.equal(
			lines.some((line) => line.includes("three")),
			true,
		);
		assert.equal(lines.join("").includes(CURSOR_MARKER), true);
	});
});
