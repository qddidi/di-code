import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const RESET = "\x1b[0m";
const RESET_FOREGROUND = "\x1b[39m";
const ACCENT = "\x1b[38;5;45m";
const PALE_BLUE = "\x1b[38;5;117m";
const DIM = "\x1b[38;5;245m";
const SELECTED_BACKGROUND = "\x1b[48;5;236m";

export interface SelectionPanelOptions {
	/** Optional compact heading rendered into the panel border. */
	readonly title?: string;
	/** Visible, already formatted single-line choices. */
	readonly rows?: readonly string[];
	/** Index of the selected choice within `rows`; omit when the panel has no selectable row. */
	readonly selectedIndex?: number;
	/** One-based selection position in the complete result set. */
	readonly position?: number;
	/** Total number of selectable choices in the complete result set. */
	readonly total?: number;
	/** Optional muted line rendered after the position counter. */
	readonly hint?: string;
	/** Message used when there are no visible choices. */
	readonly emptyText?: string;
}

function paint(color: string, text: string): string {
	return `${color}${text}${RESET_FOREGROUND}`;
}

function singleLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

/**
 * Presentation-only chrome for keyboard selection surfaces.
 *
 * Callers own filtering, navigation, and callbacks. The panel owns its pale-blue frame and normalizes line breaks.
 */
export class SelectionPanel implements Component {
	private readonly options: Omit<SelectionPanelOptions, "rows"> & { readonly rows: readonly string[] };

	constructor(options: SelectionPanelOptions) {
		this.options = {
			...options,
			title: options.title ? singleLine(options.title) : undefined,
			rows: (options.rows ?? []).map(singleLine),
			hint: options.hint ? singleLine(options.hint) : undefined,
			emptyText: options.emptyText ? singleLine(options.emptyText) : undefined,
		};
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (width < 3) return this.renderContent(width);
		const innerWidth = width - 2;
		const content = this.renderContent(innerWidth);
		const title = this.options.title ? truncateToWidth(` ${this.options.title} `, innerWidth, "") : "";
		const top = paint(PALE_BLUE, `┌${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}┐`);
		const bottom = paint(PALE_BLUE, `└${"─".repeat(innerWidth)}┘`);
		const body = content.map(
			(line) =>
				`${paint(PALE_BLUE, "│")}${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}${paint(PALE_BLUE, "│")}`,
		);
		return [top, ...body, bottom];
	}

	private renderContent(width: number): string[] {
		const lines: string[] = [];

		if (this.options.rows.length === 0) {
			if (this.options.emptyText) lines.push(truncateToWidth(paint(DIM, `  ${this.options.emptyText}`), width, ""));
			if (this.options.total !== undefined) lines.push(this.renderCounter(width));
			if (this.options.hint) lines.push(this.renderHint(width));
			return lines;
		}

		for (let index = 0; index < this.options.rows.length; index += 1) {
			const row = this.options.rows[index];
			if (row === undefined) continue;
			lines.push(this.renderRow(row, index === this.options.selectedIndex, width));
		}
		if (this.options.total !== undefined) lines.push(this.renderCounter(width));
		if (this.options.hint) lines.push(this.renderHint(width));
		return lines;
	}

	private renderRow(content: string, selected: boolean, width: number): string {
		const cursor = selected ? paint(ACCENT, "› ") : "  ";
		const row = truncateToWidth(`${cursor}${content}`, width, "");
		if (!selected) return `${row}${RESET}`;
		return `${SELECTED_BACKGROUND}${row}${SELECTED_BACKGROUND}${" ".repeat(Math.max(0, width - visibleWidth(row)))}${RESET}`;
	}

	private renderCounter(width: number): string {
		const position = this.options.position ?? 0;
		return truncateToWidth(paint(DIM, `  (${position}/${this.options.total ?? 0})`), width, "");
	}

	private renderHint(width: number): string {
		return truncateToWidth(paint(DIM, `  ${this.options.hint ?? ""}`), width, "");
	}
}
