import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Editor } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { Text } from "../src/components/text.ts";
import { CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function flushRender(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("built-in component integration", () => {
	it("renders Text and routes terminal input through the focused Input", async () => {
		const terminal = new VirtualTerminal(8, 4);
		const tui = new TUI(terminal);
		const input = new Input();
		tui.addChild(new Text("title"));
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		terminal.sendInput("界");
		await flushRender();

		assert.equal(input.getValue(), "界");
		assert.equal(terminal.output.includes(CURSOR_MARKER), false);
		tui.stop();
	});

	it("switches focus from Input to Editor without producing duplicate markers", async () => {
		const terminal = new VirtualTerminal(6, 3);
		const tui = new TUI(terminal);
		const input = new Input();
		const editor = new Editor({ maxHeight: 2 });
		input.setValue("one");
		editor.setValue("two\nthree");
		tui.addChild(input);
		tui.addChild(editor);
		tui.setFocus(input);
		tui.start();
		terminal.clearOutput();

		tui.setFocus(editor);
		await flushRender();

		assert.equal(input.focused, false);
		assert.equal(editor.focused, true);
		assert.equal(terminal.output.includes(CURSOR_MARKER), false);
		tui.stop();
	});

	it("reflows Text and Editor after a narrow resize", async () => {
		const terminal = new VirtualTerminal(8, 4);
		const tui = new TUI(terminal);
		const editor = new Editor({ maxHeight: 2 });
		editor.setValue("A界🙂B");
		tui.addChild(new Text("abcdef"));
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		terminal.clearOutput();

		terminal.resize(3, 4);
		await flushRender();

		assert.equal(terminal.output.includes("\x1b[2J\x1b[H"), true);
		assert.equal(terminal.output.includes(CURSOR_MARKER), false);
		tui.stop();
	});
});
