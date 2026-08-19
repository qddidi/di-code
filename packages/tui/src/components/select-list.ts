import { fuzzyFilter } from "../fuzzy.ts";
import { KeybindingsManager } from "../keybindings.ts";
import { Key, matchesKey } from "../keys.ts";
import type { Component, Focusable } from "../tui.ts";
import { SelectionPanel } from "./selection-panel.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface SelectItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface SelectListOptions {
	readonly maxVisible?: number;
	readonly keybindings?: KeybindingsManager;
}

function graphemes(value: string): string[] {
	return [...segmenter.segment(value)].map(({ segment }) => segment);
}

export class SelectList implements Component, Focusable {
	focused = false;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;
	private readonly items: SelectItem[];
	private filteredItems: SelectItem[];
	private readonly maxVisible: number;
	private readonly keybindings: KeybindingsManager;
	private filter = "";
	private selectedIndex = 0;

	constructor(items: readonly SelectItem[], options: SelectListOptions = {}) {
		this.items = [...items];
		this.filteredItems = [...items];
		this.maxVisible = options.maxVisible ?? 5;
		if (!Number.isInteger(this.maxVisible) || this.maxVisible <= 0)
			throw new Error("SelectList maxVisible must be a positive integer");
		this.keybindings = options.keybindings ?? new KeybindingsManager();
	}

	setFilter(query: string): void {
		this.filter = query;
		this.filteredItems = fuzzyFilter(
			this.items,
			query,
			(item) => `${item.label} ${item.value} ${item.description ?? ""}`,
		);
		this.selectedIndex = 0;
	}

	getFilter(): string {
		return this.filter;
	}

	getSelectedItem(): SelectItem | null {
		return this.filteredItems[this.selectedIndex] ?? null;
	}

	setSelectedIndex(index: number): void {
		if (this.filteredItems.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.filteredItems.length === 0)
			return new SelectionPanel({ emptyText: `No matches for: ${this.filter}`, total: 0 }).render(width);
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const end = Math.min(start + this.maxVisible, this.filteredItems.length);
		const rows: string[] = [];
		for (let index = start; index < end; index += 1) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const description = item.description?.replace(/[\r\n]+/g, " ").trim();
			const suffix = description ? ` - ${description}` : "";
			rows.push(`${item.label}${suffix}`);
		}
		return new SelectionPanel({
			rows,
			selectedIndex: this.selectedIndex - start,
			position: this.selectedIndex + 1,
			total: this.filteredItems.length,
		}).render(width);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const item = this.getSelectedItem();
			if (item) this.onSelect?.(item);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			const parts = graphemes(this.filter);
			parts.pop();
			this.setFilter(parts.join(""));
			return;
		}
		if (
			[...data].some((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code < 0x20 || code === 0x7f;
			})
		)
			return;
		const text = graphemes(data).join("");
		if (text.length > 0) this.setFilter(this.filter + text);
	}

	private move(direction: -1 | 1): void {
		if (this.filteredItems.length === 0) return;
		this.selectedIndex = (this.selectedIndex + direction + this.filteredItems.length) % this.filteredItems.length;
		const selected = this.filteredItems[this.selectedIndex];
		if (selected) this.onSelectionChange?.(selected);
	}
}
