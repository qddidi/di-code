import type { AutocompleteContext, AutocompleteItem, AutocompleteProvider } from "../autocomplete.ts";
import { KeybindingsManager } from "../keybindings.ts";
import { Key, matchesKey } from "../keys.ts";
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

function tokenBeforeCursor(text: string, cursor: number): string {
	const beforeCursor = text.slice(0, cursor);
	const delimiters = [...beforeCursor.matchAll(/\s/g)].map((match) => (match.index ?? -1) + match[0].length);
	const delimiter = Math.max(0, ...delimiters);
	return beforeCursor.slice(delimiter);
}

function renderSoftwareCursor(line: string): string {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex < 0) return line;
	const before = line.slice(0, markerIndex + CURSOR_MARKER.length);
	const after = line.slice(markerIndex + CURSOR_MARKER.length);
	if (after.length === 0) return `${before}\x1b[7m \x1b[0m`;
	const cursorEnd = nextBoundary(after, 0);
	return `${before}\x1b[7m${after.slice(0, cursorEnd)}\x1b[0m${after.slice(cursorEnd)}`;
}

interface CursorPosition {
	line: number;
	column: number;
}

export interface EditorOptions {
	readonly maxHeight?: number;
	readonly keybindings?: KeybindingsManager;
	readonly autocomplete?: AutocompleteProvider;
	/** Return true to submit an Enter-confirmed autocomplete selection. */
	readonly submitAutocomplete?: (context: AutocompleteContext, item: AutocompleteItem) => boolean;
}

export class Editor implements Component, Focusable {
	disableSubmit = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	onCommand?: (data: string) => boolean;
	onInterrupt?: () => void;
	onChange?: (value: string) => void;
	onPaste?: (value: string) => string;

	private value = "";
	private cursor = 0;
	private isFocused = false;
	private preferredColumn: number | undefined;
	private pasteBuffer = "";
	private isPasting = false;
	private readonly maxHeight: number | undefined;
	private readonly keybindings: KeybindingsManager;
	private readonly autocompleteProvider?: AutocompleteProvider;
	private readonly submitAutocomplete?: (context: AutocompleteContext, item: AutocompleteItem) => boolean;
	private autocompleteItems: AutocompleteItem[] = [];
	private autocompleteIndex = 0;
	private autocompletePrefix = "";
	private autocompleteToken = 0;
	private autocompleteAbort?: AbortController;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedCursor?: number;
	private cachedFocused?: boolean;
	private cachedLines?: string[];
	onAutocompleteChange?: () => void;

	constructor(options: EditorOptions = {}) {
		if (options.maxHeight !== undefined && (!Number.isInteger(options.maxHeight) || options.maxHeight <= 0)) {
			throw new Error("Editor maxHeight must be a positive integer");
		}
		this.maxHeight = options.maxHeight;
		this.keybindings = options.keybindings ?? new KeybindingsManager();
		this.autocompleteProvider = options.autocomplete;
		this.submitAutocomplete = options.submitAutocomplete;
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

	getAutocompleteItems(): AutocompleteItem[] {
		return [...this.autocompleteItems];
	}

	getAutocompleteIndex(): number {
		return this.autocompleteIndex;
	}

	isShowingAutocomplete(): boolean {
		return this.autocompleteItems.length > 0;
	}

	cancelAutocomplete(): void {
		this.autocompleteToken += 1;
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
		this.autocompleteItems = [];
		this.autocompleteIndex = 0;
		this.autocompletePrefix = "";
		this.onAutocompleteChange?.();
	}

	async requestAutocomplete(force = false): Promise<void> {
		if (!this.autocompleteProvider) return;
		this.autocompleteAbort?.abort();
		const controller = new AbortController();
		this.autocompleteAbort = controller;
		const token = ++this.autocompleteToken;
		const snapshot: AutocompleteContext = { text: this.value, cursor: this.cursor };
		const suggestions = await this.autocompleteProvider.getSuggestions(snapshot, { signal: controller.signal, force });
		if (
			controller.signal.aborted ||
			token !== this.autocompleteToken ||
			this.value !== snapshot.text ||
			this.cursor !== snapshot.cursor
		)
			return;
		this.autocompleteAbort = undefined;
		this.autocompleteItems = suggestions ? [...suggestions.items] : [];
		this.autocompletePrefix = suggestions?.prefix ?? "";
		this.autocompleteIndex = 0;
		this.onAutocompleteChange?.();
	}

	setValue(value: string): void {
		this.clearAutocompleteForEdit();
		const normalized = normalizeEditorText(value);
		this.value = normalized;
		this.cursor = normalized.length;
		this.preferredColumn = undefined;
		this.invalidate();
		this.onChange?.(this.value);
	}

	/** Inserts external text at the current cursor without moving focus. */
	insertTextAtCursor(value: string): void {
		this.insert(normalizeEditorText(value));
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
		if (this.consumeUnbracketedPaste(data)) return;
		if (this.onCommand?.(data) === true) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onInterrupt?.();
			return;
		}
		if (this.isShowingAutocomplete()) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
				const direction = this.keybindings.matches(data, "tui.select.up") ? -1 : 1;
				this.autocompleteIndex =
					(this.autocompleteIndex + direction + this.autocompleteItems.length) % this.autocompleteItems.length;
				this.onAutocompleteChange?.();
				return;
			}
			if (this.keybindings.matches(data, "tui.input.tab") || this.keybindings.matches(data, "tui.input.submit")) {
				const item = this.autocompleteItems[this.autocompleteIndex];
				const submit =
					item !== undefined &&
					this.keybindings.matches(data, "tui.input.submit") &&
					this.submitAutocomplete?.({ text: this.value, cursor: this.cursor }, item) === true;
				this.applyAutocomplete();
				if (submit && this.onSubmit && !this.disableSubmit) this.onSubmit(this.value);
				return;
			}
		}
		if (this.keybindings.matches(data, "tui.input.tab") && this.autocompleteProvider) {
			void this.requestAutocomplete(true);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.submit")) {
			if (this.onSubmit && !this.disableSubmit) this.onSubmit(this.value);
			else this.insert("\n");
			return;
		}
		if (this.keybindings.matches(data, "tui.input.newLine")) {
			this.insert("\n");
			return;
		}
		if (this.keybindings.matches(data, "tui.input.cancel")) {
			this.onEscape?.();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.moveLeft();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.moveRight();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
			this.moveVertical(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
			this.moveVertical(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
			this.moveHome();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveEnd();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
			this.deleteBackward();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteCharForward")) {
			this.deleteForward();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToLineStart();
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
		const layoutWidth = this.focused ? Math.max(1, width - 1) : width;
		const wrapped = wrapTextWithAnsi(marked, layoutWidth);
		const cursorLine = Math.max(
			0,
			wrapped.findIndex((line) => line.includes(CURSOR_MARKER)),
		);
		const firstVisibleLine = this.maxHeight ? Math.max(0, cursorLine - this.maxHeight + 1) : 0;
		const visibleLines = this.maxHeight ? wrapped.slice(firstVisibleLine, firstVisibleLine + this.maxHeight) : wrapped;
		const lines = visibleLines.map((wrappedLine) => {
			const line = this.focused ? renderSoftwareCursor(wrappedLine) : wrappedLine.replace(CURSOR_MARKER, "");
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
		this.cancelAutocomplete();
		this.insert(this.onPaste?.(normalizePastedText(pasted)) ?? normalizePastedText(pasted));
		if (remainder) this.handleInput(remainder);
		return true;
	}

	private consumeUnbracketedPaste(data: string): boolean {
		if (!/[\r\n]/.test(data) || !/[^\r\n]/.test(data)) return false;
		this.cancelAutocomplete();
		const pasted = normalizePastedText(data);
		this.insert(this.onPaste?.(pasted) ?? pasted);
		return true;
	}

	private applyAutocomplete(): void {
		const item = this.autocompleteItems[this.autocompleteIndex];
		if (!item || !this.autocompleteProvider) return;
		const result = this.autocompleteProvider.applyCompletion(
			{ text: this.value, cursor: this.cursor },
			item,
			this.autocompletePrefix,
		);
		this.value = result.text;
		this.cursor = result.cursor;
		this.preferredColumn = undefined;
		this.invalidate();
		this.cancelAutocomplete();
		this.onChange?.(this.value);
	}

	private insert(text: string): void {
		if (text.length === 0) return;
		this.clearAutocompleteForEdit();
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.preferredColumn = undefined;
		this.invalidate();
		this.onChange?.(this.value);
		this.requestTriggeredAutocomplete();
	}

	private requestTriggeredAutocomplete(): void {
		if (!this.autocompleteProvider) return;
		const token = tokenBeforeCursor(this.value, this.cursor);
		if (!token.startsWith("@") && !/^\/[^\s/]*$/.test(token)) return;
		void this.requestAutocomplete();
	}

	private moveLeft(): void {
		this.clearAutocompleteForEdit();
		this.cursor = previousBoundary(this.value, this.cursor);
		this.preferredColumn = undefined;
	}

	private moveRight(): void {
		this.clearAutocompleteForEdit();
		this.cursor = nextBoundary(this.value, this.cursor);
		this.preferredColumn = undefined;
	}

	private moveHome(): void {
		this.clearAutocompleteForEdit();
		this.cursor = this.lineStart(this.cursor);
		this.preferredColumn = 0;
	}

	private moveEnd(): void {
		this.clearAutocompleteForEdit();
		const nextBreak = this.value.indexOf("\n", this.cursor);
		this.cursor = nextBreak < 0 ? this.value.length : nextBreak;
		this.preferredColumn = this.getCursorPosition().column;
	}

	private moveVertical(direction: -1 | 1): void {
		this.clearAutocompleteForEdit();
		const position = this.getCursorPosition();
		const desiredColumn = this.preferredColumn ?? position.column;
		const targetLine = Math.max(0, Math.min(this.lineCount() - 1, position.line + direction));
		this.cursor = this.offsetForLineColumn(targetLine, desiredColumn);
		this.preferredColumn = desiredColumn;
	}

	private deleteBackward(): void {
		if (this.cursor === 0) return;
		this.clearAutocompleteForEdit();
		const previous = previousBoundary(this.value, this.cursor);
		this.value = this.value.slice(0, previous) + this.value.slice(this.cursor);
		this.cursor = previous;
		this.invalidate();
		this.onChange?.(this.value);
	}

	private deleteForward(): void {
		if (this.cursor >= this.value.length) return;
		this.clearAutocompleteForEdit();
		const next = nextBoundary(this.value, this.cursor);
		this.value = this.value.slice(0, this.cursor) + this.value.slice(next);
		this.invalidate();
		this.onChange?.(this.value);
	}

	private deleteToLineStart(): void {
		const start = this.lineStart(this.cursor);
		if (start === this.cursor) return;
		this.clearAutocompleteForEdit();
		this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
		this.cursor = start;
		this.preferredColumn = undefined;
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

	private clearAutocompleteForEdit(): void {
		if (this.autocompleteItems.length > 0 || this.autocompleteAbort) this.cancelAutocomplete();
	}
}
