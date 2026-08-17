import { marked, type Token, type Tokens } from "marked";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export interface MarkdownTheme {
	readonly heading: (text: string) => string;
	readonly link: (text: string) => string;
	readonly linkUrl: (text: string) => string;
	readonly code: (text: string) => string;
	readonly codeBlock: (text: string) => string;
	readonly codeBlockBorder: (text: string) => string;
	readonly quote: (text: string) => string;
	readonly quoteBorder: (text: string) => string;
	readonly hr: (text: string) => string;
	readonly listBullet: (text: string) => string;
	readonly bold: (text: string) => string;
	readonly italic: (text: string) => string;
	readonly strikethrough: (text: string) => string;
	readonly underline: (text: string) => string;
	readonly highlightCode?: (code: string, language?: string) => string[];
}

export interface MarkdownOptions {
	readonly paddingX?: number;
	readonly paddingY?: number;
	readonly theme?: MarkdownTheme;
}

const ANSI_THEME: MarkdownTheme = {
	heading: (text) => `\x1b[1m${text}\x1b[22m`,
	link: (text) => text,
	linkUrl: (text) => `\x1b[2m${text}\x1b[22m`,
	code: (text) => `\x1b[2m${text}\x1b[22m`,
	codeBlock: (text) => `\x1b[2m${text}\x1b[22m`,
	codeBlockBorder: (text) => `\x1b[2m${text}\x1b[22m`,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => `\x1b[2m${text}\x1b[22m`,
	listBullet: (text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => `\x1b[3m${text}\x1b[23m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
	underline: (text) => `\x1b[4m${text}\x1b[24m`,
};

function sanitizeMarkdown(source: string): string {
	return Array.from(source.replace(/\r\n?/g, "\n").replace(/\t/g, "   "))
		.filter((character) => {
			if (character === "\n") return true;
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f);
		})
		.join("");
}

function hasPartialClosingFence(source: string): boolean {
	return /(?:^|\n)[`~]{1,2}\s*$/.test(source);
}

function tableLine(cells: readonly Tokens.TableCell[], theme: MarkdownTheme): string {
	return `| ${cells.map((cell) => renderInline(cell.tokens, theme)).join(" | ")} |`;
}

function renderInline(tokens: readonly Token[], theme: MarkdownTheme): string {
	return tokens
		.map((token) => {
			switch (token.type) {
				case "strong":
					return theme.bold(renderInline(token.tokens ?? [], theme));
				case "em":
					return theme.italic(renderInline(token.tokens ?? [], theme));
				case "del":
					return theme.strikethrough(renderInline(token.tokens ?? [], theme));
				case "codespan":
					return theme.code(sanitizeMarkdown(token.text));
				case "link":
					return `${theme.link(renderInline(token.tokens ?? [], theme))} ${theme.linkUrl(`(${sanitizeMarkdown(token.href)})`)}`;
				case "image":
					return `${sanitizeMarkdown(token.text)} ${theme.linkUrl(`(${sanitizeMarkdown(token.href)})`)}`;
				case "br":
					return "\n";
				case "html":
					return sanitizeMarkdown(token.text);
				case "text":
					return token.tokens ? renderInline(token.tokens, theme) : sanitizeMarkdown(token.text);
				case "escape":
					return sanitizeMarkdown(token.text);
				default:
					return sanitizeMarkdown(token.raw);
			}
		})
		.join("");
}

function renderList(items: readonly Tokens.ListItem[], ordered: boolean, theme: MarkdownTheme, depth = 0): string[] {
	const lines: string[] = [];
	for (const [index, item] of items.entries()) {
		const marker = ordered ? `${index + 1}.` : depth === 0 ? "•" : "◦";
		const prefix = `${"  ".repeat(depth)}${theme.listBullet(marker)} `;
		const content: string[] = [];
		for (const token of item.tokens) {
			if (token.type === "checkbox") continue;
			if (token.type === "list") content.push(...renderList(token.items, token.ordered, theme, depth + 1));
			else if (token.type === "paragraph" || token.type === "text")
				content.push(renderInline(token.tokens ?? [token], theme));
			else content.push(...renderBlocks([token], theme));
		}
		const first = content.shift() ?? sanitizeMarkdown(item.text);
		const checkbox = item.task ? `[${item.checked ? "x" : " "}] ` : "";
		lines.push(`${prefix}${checkbox}${first}`);
		lines.push(...content);
	}
	return lines;
}

function renderBlocks(tokens: readonly Token[], theme: MarkdownTheme): string[] {
	const lines: string[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "space":
				lines.push("");
				break;
			case "heading":
				lines.push(theme.heading(renderInline(token.tokens ?? [], theme)));
				break;
			case "paragraph":
				lines.push(...renderInline(token.tokens ?? [], theme).split("\n"));
				break;
			case "text":
				lines.push(...renderInline(token.tokens ?? [token], theme).split("\n"));
				break;
			case "blockquote": {
				const quoted = renderBlocks(token.tokens ?? [], theme);
				lines.push(...quoted.map((line) => `${theme.quoteBorder("│")} ${theme.quote(line)}`));
				break;
			}
			case "list":
				lines.push(...renderList(token.items, token.ordered, theme));
				break;
			case "code": {
				const language = token.lang ? ` ${sanitizeMarkdown(token.lang)}` : "";
				lines.push(theme.codeBlockBorder(`\`\`\`${language}`));
				const code = sanitizeMarkdown(token.text);
				const highlighted = theme.highlightCode?.(code, token.lang);
				lines.push(...(highlighted ?? code.split("\n").map((line) => theme.codeBlock(line))));
				lines.push(theme.codeBlockBorder("```"));
				break;
			}
			case "hr":
				lines.push(theme.hr("─".repeat(3)));
				break;
			case "table":
				lines.push(tableLine(token.header, theme));
				lines.push(`| ${token.header.map(() => "---").join(" | ")} |`);
				lines.push(...token.rows.map((row: Tokens.TableCell[]) => tableLine(row, theme)));
				break;
			case "html":
				lines.push(sanitizeMarkdown(token.text));
				break;
			default:
				lines.push(sanitizeMarkdown(token.raw));
		}
	}
	return lines;
}

export class Markdown implements Component {
	private text: string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	private readonly theme: MarkdownTheme;
	private stableText = "";
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, options: MarkdownOptions = {}) {
		this.text = text;
		this.paddingX = options.paddingX ?? 0;
		this.paddingY = options.paddingY ?? 0;
		this.theme = options.theme ?? ANSI_THEME;
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
		const normalized = sanitizeMarkdown(this.text);
		const source = hasPartialClosingFence(normalized) && this.stableText ? this.stableText : normalized;
		if (!hasPartialClosingFence(normalized)) this.stableText = normalized;
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const body = renderBlocks(marked.lexer(source), this.theme).flatMap((line) => wrapTextWithAnsi(line, contentWidth));
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
