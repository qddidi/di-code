import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
} from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";

const signalOptions = { signal: new AbortController().signal };

describe("CombinedAutocompleteProvider", () => {
	it("fuzzy completes slash commands and applies a trailing space", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "help", description: "Show help" },
				{ name: "model", description: "Choose model" },
			],
			".",
		);

		const suggestions = await provider.getSuggestions({ text: "/he", cursor: 3 }, signalOptions);
		const item = suggestions?.items[0];
		const applied = item ? provider.applyCompletion({ text: "/he", cursor: 3 }, item, suggestions?.prefix ?? "") : null;

		assert.equal(suggestions?.prefix, "/he");
		assert.equal(item?.value, "help");
		assert.deepEqual(applied, { text: "/help ", cursor: 6 });
	});

	it("completes files and directories only inside the configured root", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-autocomplete-"));
		try {
			mkdirSync(join(root, "src", "utils"), { recursive: true });
			writeFileSync(join(root, "src", "main.ts"), "export {};");
			writeFileSync(join(root, "README.md"), "readme");
			const provider = new CombinedAutocompleteProvider([], root);

			const suggestions = await provider.getSuggestions({ text: "@src/", cursor: 5 }, signalOptions);
			const values = suggestions?.items.map((item) => item.value) ?? [];
			assert.deepEqual(values, ["@src/utils/", "@src/main.ts"]);
			assert.equal(
				values.some((value) => value.startsWith("@../")),
				false,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns no suggestions for an aborted request or ordinary prose", async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = new CombinedAutocompleteProvider([], ".");

		assert.equal(await provider.getSuggestions({ text: "@", cursor: 1 }, { signal: controller.signal }), null);
		assert.equal(await provider.getSuggestions({ text: "hello", cursor: 5 }, signalOptions), null);
	});

	it("treats newlines as token separators and does not follow links outside root", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-autocomplete-root-"));
		const outside = mkdtempSync(join(tmpdir(), "di-code-autocomplete-outside-"));
		try {
			writeFileSync(join(outside, "secret.txt"), "secret");
			symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
			const provider = new CombinedAutocompleteProvider([{ name: "help" }], root);

			assert.equal(
				(await provider.getSuggestions({ text: "note\n/he", cursor: 7 }, signalOptions))?.items[0]?.value,
				"help",
			);
			assert.equal(await provider.getSuggestions({ text: "@linked/", cursor: 8 }, signalOptions), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("Editor autocomplete", () => {
	it("opens slash-command suggestions automatically and refilters as the command is typed", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "help", description: "Show help" },
				{ name: "model", description: "Choose model" },
			],
			".",
		);
		const editor = new Editor({ autocomplete: provider });

		editor.handleInput("/");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(
			editor.getAutocompleteItems().map((item) => item.value),
			["help", "model"],
		);

		editor.handleInput("m");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(
			editor.getAutocompleteItems().map((item) => item.value),
			["model"],
		);
	});

	it("opens suggestions, navigates, and applies the selected item", async () => {
		const provider = new CombinedAutocompleteProvider([{ name: "help" }, { name: "hello" }], ".");
		const editor = new Editor({ autocomplete: provider });
		editor.setValue("/he");

		await editor.requestAutocomplete(true);
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");

		assert.equal(editor.getValue(), "/hello ");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("cancels autocomplete with escape without invoking editor escape", async () => {
		const provider = new CombinedAutocompleteProvider([{ name: "help" }], ".");
		const editor = new Editor({ autocomplete: provider });
		let escaped = 0;
		editor.onEscape = () => {
			escaped += 1;
		};
		editor.setValue("/h");

		await editor.requestAutocomplete(true);
		editor.handleInput("\x1b");

		assert.equal(editor.isShowingAutocomplete(), false);
		assert.equal(escaped, 0);
	});

	it("drops a stale asynchronous response after text changes", async () => {
		const pending: Array<(result: AutocompleteSuggestions | null) => void> = [];
		const provider: AutocompleteProvider = {
			getSuggestions: () => new Promise((resolve) => pending.push(resolve)),
			applyCompletion: (context) => ({ text: context.text, cursor: context.cursor }),
		};
		const editor = new Editor({ autocomplete: provider });
		editor.setValue("/o");
		const first = editor.requestAutocomplete(true);
		editor.setValue("/n");
		const second = editor.requestAutocomplete(true);

		pending[0]?.({ items: [{ value: "old", label: "old" }], prefix: "/o" });
		pending[1]?.({ items: [{ value: "new", label: "new" }], prefix: "/n" });
		await Promise.all([first, second]);

		assert.deepEqual(
			editor.getAutocompleteItems().map((item) => item.value),
			["new"],
		);
	});

	it("cancels visible suggestions when the editor text changes", async () => {
		const provider = new CombinedAutocompleteProvider([{ name: "help" }], ".");
		const editor = new Editor({ autocomplete: provider });
		editor.setValue("/h");
		await editor.requestAutocomplete(true);

		editor.handleInput("e");

		assert.equal(editor.getValue(), "/he");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("inserts a large paste atomically and does not open autocomplete", () => {
		const editor = new Editor({ autocomplete: new CombinedAutocompleteProvider([{ name: "help" }], ".") });
		let changes = 0;
		editor.onChange = () => {
			changes += 1;
		};
		const pasted = `${"x".repeat(5000)}世界\n第二行`;

		editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);

		assert.equal(editor.getValue(), pasted);
		assert.equal(changes, 1);
		assert.equal(editor.isShowingAutocomplete(), false);
	});
});
