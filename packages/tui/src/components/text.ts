import type { Component } from "../tui.ts";
import { visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export class Text implements Component {
	private text: string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text = "", paddingX = 0, paddingY = 0) {
		if (!Number.isInteger(paddingX) || paddingX < 0 || !Number.isInteger(paddingY) || paddingY < 0) {
			throw new Error("Text padding must be non-negative integers");
		}
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) return this.cachedLines;
		if (this.text.length === 0 || width <= 0) return this.store(width, []);

		const leftPadding = Math.min(this.paddingX, width);
		const rightPadding = Math.min(this.paddingX, Math.max(0, width - leftPadding));
		const contentWidth = width - leftPadding - rightPadding;
		const wrapped = contentWidth > 0 ? wrapTextWithAnsi(this.text.replace(/\t/g, "   "), contentWidth) : [];
		const horizontalPrefix = " ".repeat(leftPadding);
		const contentLines = wrapped.map((line) => {
			const used = leftPadding + visibleWidth(line) + rightPadding;
			return `${horizontalPrefix}${line}${" ".repeat(Math.max(0, width - used + rightPadding))}`;
		});
		const emptyLine = " ".repeat(width);
		const verticalPadding = Array.from({ length: this.paddingY }, () => emptyLine);
		return this.store(width, [...verticalPadding, ...contentLines, ...verticalPadding]);
	}

	private store(width: number, lines: string[]): string[] {
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
