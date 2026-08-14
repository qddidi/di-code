import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface TruncatedTextOptions {
	readonly paddingX?: number;
	readonly paddingY?: number;
	readonly ellipsis?: string;
}

export class TruncatedText implements Component {
	private text: string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	private readonly ellipsis: string;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, options: TruncatedTextOptions = {}) {
		this.text = text;
		this.paddingX = options.paddingX ?? 0;
		this.paddingY = options.paddingY ?? 0;
		this.ellipsis = options.ellipsis ?? "...";
		if (!Number.isInteger(this.paddingX) || this.paddingX < 0)
			throw new Error("TruncatedText paddingX must be a non-negative integer");
		if (!Number.isInteger(this.paddingY) || this.paddingY < 0)
			throw new Error("TruncatedText paddingY must be a non-negative integer");
	}

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) return this.cachedLines;
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const firstLine = this.text.replace(/\r\n?/g, "\n").split("\n")[0] ?? "";
		const content = truncateToWidth(firstLine, contentWidth, this.ellipsis, true);
		const horizontal = `${" ".repeat(this.paddingX)}${content}${" ".repeat(Math.max(0, width - this.paddingX - visibleWidth(content)))}`;
		const vertical = " ".repeat(width);
		const lines = [
			...Array.from({ length: this.paddingY }, () => vertical),
			truncateToWidth(horizontal, width, ""),
			...Array.from({ length: this.paddingY }, () => vertical),
		];
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
