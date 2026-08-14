import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export interface MarkdownOptions {
	readonly paddingX?: number;
	readonly paddingY?: number;
}

const ANSI = {
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	code: (text: string) => `\x1b[2m${text}\x1b[22m`,
};

function renderInline(text: string): string {
	let result = "";
	let index = 0;
	while (index < text.length) {
		if (text.startsWith("**", index)) {
			const end = text.indexOf("**", index + 2);
			if (end >= 0) {
				result += ANSI.bold(renderInline(text.slice(index + 2, end)));
				index = end + 2;
				continue;
			}
		}
		if (text[index] === "*") {
			const end = text.indexOf("*", index + 1);
			if (end > index + 1) {
				result += ANSI.italic(renderInline(text.slice(index + 1, end)));
				index = end + 1;
				continue;
			}
		}
		if (text[index] === "`") {
			const end = text.indexOf("`", index + 1);
			if (end > index + 1) {
				result += ANSI.code(text.slice(index + 1, end));
				index = end + 1;
				continue;
			}
		}
		if (text[index] === "[") {
			const closeLabel = text.indexOf("](", index + 1);
			const closeUrl = closeLabel < 0 ? -1 : text.indexOf(")", closeLabel + 2);
			if (closeLabel > index && closeUrl > closeLabel) {
				result += text.slice(index + 1, closeLabel);
				index = closeUrl + 1;
				continue;
			}
		}
		result += text[index] ?? "";
		index += 1;
	}
	return result;
}

function parseBlocks(text: string): string[] {
	const lines: string[] = [];
	let fence: string | null = null;
	for (const sourceLine of text.replace(/\t/g, "   ").split(/\r?\n/)) {
		const trimmed = sourceLine.trim();
		if (fence) {
			if (trimmed.startsWith(fence)) {
				lines.push(ANSI.code(trimmed));
				fence = null;
			} else {
				lines.push(ANSI.code(`  ${sourceLine}`));
			}
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			fence = trimmed.slice(0, 3);
			lines.push(ANSI.code(trimmed));
			continue;
		}
		if (trimmed.length === 0) {
			lines.push("");
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
		if (heading) {
			lines.push(ANSI.bold(renderInline(heading[2] ?? "")));
			continue;
		}
		if (/^(?:---+|___+|\*\*\*+)$/.test(trimmed)) {
			lines.push("─".repeat(3));
			continue;
		}
		const quote = /^>\s?(.*)$/.exec(trimmed);
		if (quote) {
			lines.push(`│ ${renderInline(quote[1] ?? "")}`);
			continue;
		}
		const list = /^(?:[-+*]|\d+[.)])\s+(.+)$/.exec(trimmed);
		if (list) {
			lines.push(`• ${renderInline(list[1] ?? "")}`);
			continue;
		}
		lines.push(renderInline(sourceLine));
	}
	return lines;
}

export class Markdown implements Component {
	private text: string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, options: MarkdownOptions = {}) {
		this.text = text;
		this.paddingX = options.paddingX ?? 0;
		this.paddingY = options.paddingY ?? 0;
		if (!Number.isInteger(this.paddingX) || this.paddingX < 0)
			throw new Error("Markdown paddingX must be a non-negative integer");
		if (!Number.isInteger(this.paddingY) || this.paddingY < 0)
			throw new Error("Markdown paddingY must be a non-negative integer");
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
		const body: string[] = [];
		for (const line of parseBlocks(this.text)) body.push(...wrapTextWithAnsi(line, contentWidth));
		const left = " ".repeat(this.paddingX);
		const result = [...Array.from({ length: this.paddingY }, () => " ".repeat(width))];
		for (const line of body) {
			const padded = `${left}${line}${" ".repeat(Math.max(0, width - this.paddingX - visibleWidth(line)))}`;
			result.push(truncateToWidth(padded, width, ""));
		}
		result.push(...Array.from({ length: this.paddingY }, () => " ".repeat(width)));
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result.length > 0 ? result : [""];
		return this.cachedLines;
	}
}
