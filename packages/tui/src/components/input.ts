import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { sliceByColumn, visibleWidth } from "../utils.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function graphemeBoundaries(value: string): number[] {
	const boundaries = [0];
	for (const { index, segment } of segmenter.segment(value)) boundaries.push(index + segment.length);
	return [...new Set(boundaries)];
}

function previousBoundary(boundaries: number[], cursor: number): number {
	for (let index = boundaries.length - 1; index >= 0; index -= 1) {
		if (boundaries[index] < cursor) return boundaries[index];
	}
	return 0;
}

function normalizeSingleLine(value: string): string {
	return Array.from(value.replace(/\r\n?|\n/g, " "))
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f);
		})
		.join("");
}

export class Input implements Component, Focusable {
	focused = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	onChange?: (value: string) => void;

	private value = "";
	private cursor = 0;
	private pasteBuffer = "";
	private isPasting = false;

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		const normalized = normalizeSingleLine(value);
		if (normalized === this.value) return;
		this.value = normalized;
		this.cursor = normalized.length;
		this.onChange?.(this.value);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.consumePaste(data)) return;
		switch (data) {
			case "\r":
			case "\n":
				this.onSubmit?.(this.value);
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
			case "\x01":
			case "\x1b[H":
				this.cursor = 0;
				return;
			case "\x05":
			case "\x1b[F":
				this.cursor = this.value.length;
				return;
			case "\x7f":
			case "\b":
				this.deleteBackward();
				return;
			case "\x1b[3~":
				this.deleteForward();
				return;
		}

		const printable = normalizeSingleLine(data);
		if (printable.length > 0 && printable === data) this.insert(printable);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const cursorColumn = visibleWidth(this.value.slice(0, this.cursor));
		const startColumn = Math.max(0, cursorColumn - width + 1);
		const beforeCursor = sliceByColumn(this.value, startColumn, cursorColumn - startColumn);
		const usedBefore = visibleWidth(beforeCursor);
		const remaining = Math.max(0, width - usedBefore);
		const afterCursor = sliceByColumn(this.value, cursorColumn, remaining);
		let line = `${beforeCursor}${this.focused ? CURSOR_MARKER : ""}${afterCursor}`;
		const lineWidth = visibleWidth(line);
		if (lineWidth < width) line += " ".repeat(width - lineWidth);
		return [line];
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
		this.insert(normalizeSingleLine(pasted));
		if (remainder) this.handleInput(remainder);
		return true;
	}

	private insert(text: string): void {
		if (text.length === 0) return;
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.onChange?.(this.value);
	}

	private moveLeft(): void {
		const boundaries = graphemeBoundaries(this.value);
		this.cursor = previousBoundary(boundaries, this.cursor);
	}

	private moveRight(): void {
		const boundaries = graphemeBoundaries(this.value);
		this.cursor = boundaries.find((boundary) => boundary > this.cursor) ?? this.value.length;
	}

	private deleteBackward(): void {
		if (this.cursor === 0) return;
		const previous = previousBoundary(graphemeBoundaries(this.value), this.cursor);
		this.value = this.value.slice(0, previous) + this.value.slice(this.cursor);
		this.cursor = previous;
		this.onChange?.(this.value);
	}

	private deleteForward(): void {
		if (this.cursor >= this.value.length) return;
		const next = graphemeBoundaries(this.value).find((boundary) => boundary > this.cursor) ?? this.value.length;
		this.value = this.value.slice(0, this.cursor) + this.value.slice(next);
		this.onChange?.(this.value);
	}
}
