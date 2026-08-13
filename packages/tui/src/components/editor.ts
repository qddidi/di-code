import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function boundaries(value: string): number[] {
	const result = [0];
	for (const { index, segment } of segmenter.segment(value)) result.push(index + segment.length);
	return [...new Set(result)];
}

function previousBoundary(value: string, offset: number): number {
	const values = boundaries(value);
	for (let index = values.length - 1; index >= 0; index -= 1) {
		if (values[index] < offset) return values[index];
	}
	return 0;
}

function nextBoundary(value: string, offset: number): number {
	for (const boundary of boundaries(value)) {
		if (boundary > offset) return boundary;
	}
	return value.length;
}

function normalizeEditorText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function normalizePastedText(value: string): string {
	return Array.from(normalizeEditorText(value))
		.filter((character) => {
			if (character === "\n") return true;
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f);
		})
		.join("");
}

interface CursorPosition {
	line: number;
	column: number;
}

export interface EditorOptions {
	readonly maxHeight?: number;
}

export class Editor implements Component, Focusable {
	disableSubmit = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	onCommand?: (data: string) => boolean;
	onInterrupt?: () => void;
	onChange?: (value: string) => void;

	private value = "";
	private cursor = 0;
	private isFocused = false;
	private preferredColumn: number | undefined;
	private pasteBuffer = "";
	private isPasting = false;
	private readonly maxHeight: number | undefined;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedCursor?: number;
	private cachedFocused?: boolean;
	private cachedLines?: string[];

	constructor(options: EditorOptions = {}) {
		if (options.maxHeight !== undefined && (!Number.isInteger(options.maxHeight) || options.maxHeight <= 0)) {
			throw new Error("Editor maxHeight must be a positive integer");
		}
		this.maxHeight = options.maxHeight;
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
	}

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		const normalized = normalizeEditorText(value);
		this.value = normalized;
		this.cursor = normalized.length;
		this.preferredColumn = undefined;
		this.invalidate();
		this.onChange?.(this.value);
	}

	getCursorPosition(): CursorPosition {
		const lineStart = this.lineStart(this.cursor);
		return { line: this.lineIndex(this.cursor), column: visibleWidth(this.value.slice(lineStart, this.cursor)) };
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedCursor = undefined;
		this.cachedFocused = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.consumePaste(data)) return;
		if (this.onCommand?.(data) === true) return;
		if (data === "\x03") {
			this.onInterrupt?.();
			return;
		}
		switch (data) {
			case "\r":
			case "\n":
				if (this.onSubmit && !this.disableSubmit) this.onSubmit(this.value);
				else this.insert("\n");
				return;
			case "\x1b":
				this.onEscape?.();
				return;
			case "\x1b[D":
				this.moveLeft();
				return;
			case "\x1b[C":
				this.moveRight();
				return;
			case "\x1b[A":
				this.moveVertical(-1);
				return;
			case "\x1b[B":
				this.moveVertical(1);
				return;
			case "\x01":
			case "\x1b[H":
				this.moveHome();
				return;
			case "\x05":
			case "\x1b[F":
				this.moveEnd();
				return;
			case "\x7f":
			case "\b":
				this.deleteBackward();
				return;
			case "\x1b[3~":
				this.deleteForward();
				return;
		}

		if (
			[...data].some((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f);
			})
		)
			return;
		this.insert(data);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (
			this.cachedLines &&
			this.cachedText === this.value &&
			this.cachedWidth === width &&
			this.cachedCursor === this.cursor &&
			this.cachedFocused === this.focused
		)
			return this.cachedLines;

		const marked = `${this.value.slice(0, this.cursor)}${CURSOR_MARKER}${this.value.slice(this.cursor)}`;
		const wrapped = wrapTextWithAnsi(marked, width);
		const cursorLine = Math.max(
			0,
			wrapped.findIndex((line) => line.includes(CURSOR_MARKER)),
		);
		const firstVisibleLine = this.maxHeight ? Math.max(0, cursorLine - this.maxHeight + 1) : 0;
		const visibleLines = this.maxHeight ? wrapped.slice(firstVisibleLine, firstVisibleLine + this.maxHeight) : wrapped;
		const lines = visibleLines.map((wrappedLine) => {
			const line = this.focused ? wrappedLine : wrappedLine.replace(CURSOR_MARKER, "");
			const padding = Math.max(0, width - visibleWidth(line));
			return `${line}${" ".repeat(padding)}`;
		});
		this.cachedText = this.value;
		this.cachedWidth = width;
		this.cachedCursor = this.cursor;
		this.cachedFocused = this.focused;
		this.cachedLines = lines;
		return lines;
	}

	private consumePaste(data: string): boolean {
		if (!this.isPasting && !data.includes(PASTE_START)) return false;
		if (!this.isPasting) {
			this.isPasting = true;
			this.pasteBuffer = "";
			data = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
		}
		this.pasteBuffer += data;
		const endIndex = this.pasteBuffer.indexOf(PASTE_END);
		if (endIndex < 0) return true;

		const pasted = this.pasteBuffer.slice(0, endIndex);
		const remainder = this.pasteBuffer.slice(endIndex + PASTE_END.length);
		this.pasteBuffer = "";
		this.isPasting = false;
		this.insert(normalizePastedText(pasted));
		if (remainder) this.handleInput(remainder);
		return true;
	}

	private insert(text: string): void {
		if (text.length === 0) return;
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.preferredColumn = undefined;
		this.invalidate();
		this.onChange?.(this.value);
	}

	private moveLeft(): void {
		this.cursor = previousBoundary(this.value, this.cursor);
		this.preferredColumn = undefined;
	}

	private moveRight(): void {
		this.cursor = nextBoundary(this.value, this.cursor);
		this.preferredColumn = undefined;
	}

	private moveHome(): void {
		this.cursor = this.lineStart(this.cursor);
		this.preferredColumn = 0;
	}

	private moveEnd(): void {
		const nextBreak = this.value.indexOf("\n", this.cursor);
		this.cursor = nextBreak < 0 ? this.value.length : nextBreak;
		this.preferredColumn = this.getCursorPosition().column;
	}

	private moveVertical(direction: -1 | 1): void {
		const position = this.getCursorPosition();
		const desiredColumn = this.preferredColumn ?? position.column;
		const targetLine = Math.max(0, Math.min(this.lineCount() - 1, position.line + direction));
		this.cursor = this.offsetForLineColumn(targetLine, desiredColumn);
		this.preferredColumn = desiredColumn;
	}

	private deleteBackward(): void {
		if (this.cursor === 0) return;
		const previous = previousBoundary(this.value, this.cursor);
		this.value = this.value.slice(0, previous) + this.value.slice(this.cursor);
		this.cursor = previous;
		this.invalidate();
		this.onChange?.(this.value);
	}

	private deleteForward(): void {
		if (this.cursor >= this.value.length) return;
		const next = nextBoundary(this.value, this.cursor);
		this.value = this.value.slice(0, this.cursor) + this.value.slice(next);
		this.invalidate();
		this.onChange?.(this.value);
	}

	private lineStart(offset: number): number {
		const breakIndex = this.value.lastIndexOf("\n", Math.max(0, offset - 1));
		return breakIndex < 0 ? 0 : breakIndex + 1;
	}

	private lineIndex(offset: number): number {
		let line = 0;
		for (let index = 0; index < offset; index += 1) if (this.value[index] === "\n") line += 1;
		return line;
	}

	private lineCount(): number {
		return this.value.split("\n").length;
	}

	private offsetForLineColumn(line: number, column: number): number {
		const lines = this.value.split("\n");
		let offset = 0;
		for (let index = 0; index < line; index += 1) offset += lines[index].length + 1;
		let visibleColumn = 0;
		let localOffset = 0;
		for (const { segment } of segmenter.segment(lines[line])) {
			const nextColumn = visibleColumn + visibleWidth(segment);
			if (nextColumn > column) break;
			visibleColumn = nextColumn;
			localOffset += segment.length;
		}
		return offset + localOffset;
	}
}
