import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface BoxOptions {
	readonly border?: "single" | "double" | "rounded" | "none";
	readonly title?: string;
	readonly padding?: number;
}

const BORDERS = {
	single: ["┌", "─", "┐", "│", "└", "┘"],
	double: ["╔", "═", "╗", "║", "╚", "╝"],
	rounded: ["╭", "─", "╮", "│", "╰", "╯"],
} as const;

export class Box implements Component {
	private readonly child: Component;
	private readonly options: Required<Pick<BoxOptions, "border" | "padding">> & Pick<BoxOptions, "title">;

	constructor(child: Component, options: BoxOptions = {}) {
		this.child = child;
		this.options = { border: options.border ?? "single", padding: options.padding ?? 0, title: options.title };
		if (!Number.isInteger(this.options.padding) || this.options.padding < 0)
			throw new Error("Box padding must be a non-negative integer");
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.options.border === "none") return this.child.render(width).map((line) => truncateToWidth(line, width, ""));
		if (width < 3 + this.options.padding * 2) return [" ".repeat(width)];
		const [topLeft, horizontal, topRight, vertical, bottomLeft, bottomRight] = BORDERS[this.options.border];
		const innerWidth = Math.max(1, width - 2 - this.options.padding * 2);
		const childLines = this.child.render(innerWidth);
		const topTitle = this.options.title
			? ` ${truncateToWidth(this.options.title, Math.max(0, innerWidth - 2), "")} `
			: "";
		const topFill = Math.max(0, width - 2 - visibleWidth(topTitle));
		const lines = [truncateToWidth(`${topLeft}${topTitle}${horizontal.repeat(topFill)}${topRight}`, width, "")];
		const pad = " ".repeat(this.options.padding);
		for (const childLine of childLines) {
			const content = truncateToWidth(childLine, innerWidth, "", true);
			lines.push(truncateToWidth(`${vertical}${pad}${content}${pad}${vertical}`, width, ""));
		}
		lines.push(`${bottomLeft}${horizontal.repeat(Math.max(0, width - 2))}${bottomRight}`);
		return lines;
	}
}
