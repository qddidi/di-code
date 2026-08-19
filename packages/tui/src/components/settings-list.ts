import { KeybindingsManager } from "../keybindings.ts";
import { Key, matchesKey } from "../keys.ts";
import type { Component, Focusable } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import { SelectionPanel } from "./selection-panel.ts";

export interface SettingItem {
	readonly id: string;
	readonly label: string;
	readonly currentValue: string;
	readonly values: readonly string[];
	readonly description?: string;
}

export interface SettingsListOptions {
	readonly maxVisible?: number;
	readonly keybindings?: KeybindingsManager;
	readonly title?: string;
}

export class SettingsList implements Component, Focusable {
	focused = false;
	onChange?: (id: string, value: string) => void;
	onCancel?: () => void;
	private readonly items: SettingItem[];
	private readonly values = new Map<string, string>();
	private readonly maxVisible: number;
	private readonly keybindings: KeybindingsManager;
	private readonly title: string | undefined;
	private selectedIndex = 0;

	constructor(items: readonly SettingItem[], options: SettingsListOptions = {}) {
		this.items = items.map((item) => ({ ...item, values: [...item.values] }));
		for (const item of this.items) this.values.set(item.id, item.currentValue);
		this.maxVisible = options.maxVisible ?? 6;
		this.title = options.title;
		if (!Number.isInteger(this.maxVisible) || this.maxVisible <= 0)
			throw new Error("SettingsList maxVisible must be a positive integer");
		this.keybindings = options.keybindings ?? new KeybindingsManager();
	}

	getSelectedItem(): SettingItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	getValue(id: string): string | undefined {
		return this.values.get(id);
	}

	updateValue(id: string, value: string): void {
		if (this.values.has(id)) this.values.set(id, value);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.items.length === 0)
			return new SelectionPanel({ title: this.title, emptyText: "No settings available", total: 0 }).render(width);
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const end = Math.min(start + this.maxVisible, this.items.length);
		const labelWidth = Math.min(24, Math.max(...this.items.map((item) => visibleWidth(item.label))));
		const rows: string[] = [];
		for (let index = start; index < end; index += 1) {
			const item = this.items[index];
			if (!item) continue;
			const label = `${item.label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(item.label)))}`;
			rows.push(`${label}  ${this.values.get(item.id) ?? ""}`);
		}
		return new SelectionPanel({
			title: this.title,
			rows,
			selectedIndex: this.selectedIndex - start,
			position: this.selectedIndex + 1,
			total: this.items.length,
			hint: this.items[this.selectedIndex]?.description,
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
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.cycle(1);
			return;
		}
		if (matchesKey(data, Key.left)) this.cycle(-1);
	}

	private move(direction: -1 | 1): void {
		if (this.items.length === 0) return;
		this.selectedIndex = (this.selectedIndex + direction + this.items.length) % this.items.length;
	}

	private cycle(direction: -1 | 1): void {
		const item = this.items[this.selectedIndex];
		if (!item || item.values.length === 0) return;
		const firstValue = item.values[0];
		if (firstValue === undefined) return;
		const current = this.values.get(item.id) ?? firstValue;
		const index = Math.max(0, item.values.indexOf(current));
		const next = item.values[(index + direction + item.values.length) % item.values.length];
		if (next === undefined) return;
		this.values.set(item.id, next);
		this.onChange?.(item.id, next);
	}
}
