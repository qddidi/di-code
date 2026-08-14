import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager } from "../src/keybindings.ts";
import { Key, matchesKey } from "../src/keys.ts";

describe("matchesKey", () => {
	it("matches basic keys and aliases", () => {
		assert.equal(matchesKey("\r", Key.enter), true);
		assert.equal(matchesKey("\n", "return"), true);
		assert.equal(matchesKey("\x1b", Key.escape), true);
		assert.equal(matchesKey("\t", Key.tab), true);
	});

	it("matches CSI and SS3 navigation sequences", () => {
		assert.equal(matchesKey("\x1b[A", Key.up), true);
		assert.equal(matchesKey("\x1bOA", Key.up), true);
		assert.equal(matchesKey("\x1b[H", Key.home), true);
		assert.equal(matchesKey("\x1bOF", Key.end), true);
	});

	it("matches legacy Ctrl and Alt combinations", () => {
		assert.equal(matchesKey("\x03", Key.ctrl("c")), true);
		assert.equal(matchesKey("\x1bx", Key.alt("x")), true);
		assert.equal(matchesKey("\x00", Key.ctrl("space")), true);
	});

	it("matches modified CSI navigation sequences", () => {
		assert.equal(matchesKey("\x1b[1;5D", Key.ctrl("left")), true);
		assert.equal(matchesKey("\x1b[1;3C", Key.alt("right")), true);
	});

	it("matches CSI-u and modifyOtherKeys sequences", () => {
		assert.equal(matchesKey("\x1b[13;2u", Key.shift("enter")), true);
		assert.equal(matchesKey("\x1b[27;2;13~", Key.shift("enter")), true);
		assert.equal(matchesKey("\x1b[99;5u", Key.ctrl("c")), true);
	});

	it("rejects unknown data and wrong modifiers", () => {
		assert.equal(matchesKey("\x1b[999~", Key.up), false);
		assert.equal(matchesKey("\x1b[A", Key.ctrl("up")), false);
		assert.equal(matchesKey("ab", "a"), false);
	});
});

describe("KeybindingsManager", () => {
	it("uses the default bindings", () => {
		const keybindings = new KeybindingsManager();

		assert.equal(keybindings.matches("\x1b[D", "tui.editor.cursorLeft"), true);
		assert.deepEqual(keybindings.getKeys("tui.input.submit"), [Key.enter]);
	});

	it("replaces defaults with user bindings", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.cursorLeft": Key.ctrl("l"),
		});

		assert.equal(keybindings.matches("\x0c", "tui.editor.cursorLeft"), true);
		assert.equal(keybindings.matches("\x1b[D", "tui.editor.cursorLeft"), false);
	});

	it("allows a binding to be disabled with an empty array", () => {
		const keybindings = new KeybindingsManager({ "tui.input.submit": [] });

		assert.equal(keybindings.matches("\r", "tui.input.submit"), false);
		assert.deepEqual(keybindings.getKeys("tui.input.submit"), []);
	});

	it("deduplicates configured keys without changing order", () => {
		const keybindings = new KeybindingsManager({
			"tui.select.cancel": [Key.escape, Key.ctrl("c"), Key.escape],
		});

		assert.deepEqual(keybindings.getKeys("tui.select.cancel"), [Key.escape, Key.ctrl("c")]);
	});

	it("reports conflicts between explicit user bindings defensively", () => {
		const keybindings = new KeybindingsManager({
			"tui.select.confirm": Key.enter,
			"tui.select.cancel": Key.enter,
		});

		const conflicts = keybindings.getConflicts();
		assert.deepEqual(conflicts, [
			{
				key: Key.enter,
				keybindings: ["tui.select.confirm", "tui.select.cancel"],
			},
		]);
		conflicts[0]?.keybindings.push("tui.input.submit");
		assert.equal(keybindings.getConflicts()[0]?.keybindings.length, 2);
	});

	it("rebuilds resolved keys after replacing user configuration", () => {
		const keybindings = new KeybindingsManager({ "tui.input.submit": [] });

		keybindings.setUserBindings({ "tui.input.submit": Key.ctrl("s") });

		assert.equal(keybindings.matches("\x13", "tui.input.submit"), true);
	});
});

describe("Editor keybindings", () => {
	it("preserves default navigation, deletion, and submission", () => {
		const editor = new Editor();
		let submitted = "";
		editor.onSubmit = (value) => {
			submitted = value;
		};
		editor.setValue("ab");

		editor.handleInput("\x1b[D");
		editor.handleInput("\x7f");
		editor.handleInput("\r");

		assert.equal(editor.getValue(), "b");
		assert.equal(submitted, "b");
	});

	it("uses an instance-specific binding without retaining the old default", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.cursorLeft": Key.ctrl("l"),
		});
		const editor = new Editor({ keybindings });
		editor.setValue("ab");

		editor.handleInput("\x1b[D");
		editor.handleInput("X");
		editor.handleInput("\x0c");
		editor.handleInput("Y");

		assert.equal(editor.getValue(), "abYX");
	});
});
