import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type SelectItem, SelectList } from "../src/components/select-list.ts";
import { type SettingItem, SettingsList } from "../src/components/settings-list.ts";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";
import { visibleWidth } from "../src/utils.ts";

describe("fuzzy matching", () => {
	it("matches an empty query with a neutral score", () => {
		assert.deepEqual(fuzzyMatch("", "anything"), { matches: true, score: 0 });
	});

	it("requires query characters in order and ignores case", () => {
		assert.equal(fuzzyMatch("ABC", "aXbXc").matches, true);
		assert.equal(fuzzyMatch("abc", "cba").matches, false);
	});

	it("scores consecutive and word-boundary matches better", () => {
		assert.ok(fuzzyMatch("app", "application").score < fuzzyMatch("app", "a_p_p").score);
		assert.ok(fuzzyMatch("fb", "foo-bar").score < fuzzyMatch("fb", "afbx").score);
	});

	it("filters all query tokens and preserves stable ties", () => {
		const items = ["one two", "two one", "one", "other"];

		assert.deepEqual(
			fuzzyFilter(items, "one/two", (item) => item),
			["one two", "two one"],
		);
	});

	it("supports swapped alpha numeric queries", () => {
		assert.equal(fuzzyMatch("codex52", "gpt-5.2-codex").matches, true);
	});
});

const items: SelectItem[] = [
	{ value: "apple", label: "Apple", description: "red fruit" },
	{ value: "banana", label: "Banana", description: "yellow fruit" },
	{ value: "apricot", label: "Apricot", description: "orange fruit" },
];

describe("SelectList", () => {
	it("renders selected and description text without exceeding width", () => {
		const list = new SelectList(items, { maxVisible: 3 });

		const lines = list.render(24);

		assert.equal(lines[0]?.startsWith("> "), true);
		assert.equal(
			lines.some((line) => line.includes("red fruit")),
			true,
		);
		assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	});

	it("fuzzy filters and resets selection", () => {
		const list = new SelectList(items);
		list.handleInput("ba");

		assert.equal(list.getFilter(), "ba");
		assert.equal(list.getSelectedItem()?.value, "banana");
	});

	it("cycles selection and reports changes", () => {
		const list = new SelectList(items);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);

		list.handleInput("\x1b[B");
		list.handleInput("\x1b[A");
		list.handleInput("\x1b[A");

		assert.equal(list.getSelectedItem()?.value, "apricot");
		assert.deepEqual(changes, ["banana", "apple", "apricot"]);
	});

	it("confirms the selected item and cancels on escape or ctrl-c", () => {
		const list = new SelectList(items);
		const selected: string[] = [];
		let cancelled = 0;
		list.onSelect = (item) => selected.push(item.value);
		list.onCancel = () => {
			cancelled += 1;
		};

		list.handleInput("\r");
		list.handleInput("\x1b");
		list.handleInput("\x03");

		assert.deepEqual(selected, ["apple"]);
		assert.equal(cancelled, 2);
	});

	it("renders a clear empty result", () => {
		const list = new SelectList(items);
		list.setFilter("zzz");

		assert.deepEqual(list.render(20), ["No matches for: zzz"]);
		assert.equal(list.getSelectedItem(), null);
	});

	it("deletes a grapheme from the filter", () => {
		const list = new SelectList(items);
		list.setFilter("世a");
		list.handleInput("\x7f");

		assert.equal(list.getFilter(), "世");
	});
});

const settings: SettingItem[] = [
	{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
	{
		id: "model",
		label: "Model",
		currentValue: "fast",
		values: ["fast", "smart", "local"],
		description: "Model used for requests",
	},
];

describe("SettingsList", () => {
	it("renders aligned values and selected description", () => {
		const list = new SettingsList(settings, { maxVisible: 2 });

		const lines = list.render(30);

		assert.equal(lines[0]?.startsWith("> "), true);
		assert.equal(
			lines.some((line) => line.includes("dark")),
			true,
		);
		assert.ok(lines.every((line) => visibleWidth(line) <= 30));
	});

	it("cycles values with arrow keys and closes on Enter", () => {
		const list = new SettingsList(settings);
		const changes: string[] = [];
		let cancelled = 0;
		list.onChange = (id, value) => changes.push(`${id}:${value}`);
		list.onCancel = () => {
			cancelled += 1;
		};

		list.handleInput("\x1b[C");
		list.handleInput("\x1b[D");
		list.handleInput("\r");

		assert.deepEqual(changes, ["theme:light", "theme:dark"]);
		assert.equal(cancelled, 1);
		assert.equal(list.getSelectedItem()?.id, "theme");
	});

	it("moves between settings and cancels", () => {
		const list = new SettingsList(settings);
		let cancelled = 0;
		list.onCancel = () => {
			cancelled += 1;
		};

		list.handleInput("\x1b[B");
		list.handleInput("\x1b");

		assert.equal(list.getSelectedItem()?.id, "model");
		assert.equal(cancelled, 1);
	});

	it("does not emit changes for an empty values list", () => {
		const list = new SettingsList([{ id: "empty", label: "Empty", currentValue: "", values: [] }]);
		let changed = false;
		let cancelled = false;
		list.onChange = () => {
			changed = true;
		};
		list.onCancel = () => {
			cancelled = true;
		};

		list.handleInput("\r");

		assert.equal(changed, false);
		assert.equal(cancelled, true);
	});

	it("keeps the empty state within a narrow width", () => {
		const list = new SettingsList([]);
		assert.ok(list.render(1).every((line) => visibleWidth(line) <= 1));
	});
});
