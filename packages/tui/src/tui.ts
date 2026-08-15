import { compositeOverlay, type OverlayHandle, type OverlayOptions, validateOverlayOptions } from "./overlay.ts";
import type { Terminal } from "./terminal.ts";
import { visibleWidth } from "./utils.ts";

export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
}

export interface Focusable {
	focused: boolean;
}

export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

export const CURSOR_MARKER = "\x1b_pi:c\x07";

const LINE_RESET = "\x1b[0m\x1b]8;;\x07";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR_SCROLLBACK = "\x1b[3J";

interface CursorPosition {
	readonly row: number;
	readonly column: number;
}

interface PreparedFrame {
	readonly lines: string[];
	readonly cursor: CursorPosition | null;
}

interface OverlayEntry {
	readonly component: Component;
	readonly options: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
}

export interface TUIStopOptions {
	readonly finalLines?: readonly string[];
}

export class Container implements Component {
	private readonly children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
	}

	clear(): void {
		this.children.length = 0;
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
}

export class TUI extends Container {
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private readonly terminal: Terminal;
	private previousLines: string[] = [];
	private previousColumns = 0;
	private previousRows = 0;
	private focusedComponent: Component | null = null;
	private cursorPosition: CursorPosition | null = null;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private previousViewportTop = 0;
	private started = false;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private forcePending = false;
	private readonly overlays: OverlayEntry[] = [];

	constructor(terminal: Terminal) {
		super();
		this.terminal = terminal;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	get columns(): number {
		return this.terminal.columns;
	}

	start(): void {
		if (this.started) throw new Error("TUI is already started");
		this.started = true;
		try {
			this.terminal.start(
				(data) => this.handleTerminalInput(data),
				() => this.handleResize(),
			);
			this.terminal.hideCursor();
			this.renderFrame(false);
			this.lastRenderAt = performance.now();
		} catch (error) {
			this.started = false;
			this.terminal.showCursor();
			this.terminal.stop();
			throw error;
		}
	}

	stop(options: TUIStopOptions = {}): void {
		if (!this.started) return;
		this.renderRequested = false;
		this.forcePending = false;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (options.finalLines) {
			this.renderFrame(false, [...options.finalLines]);
			const targetRow = this.cursorRow + 1;
			const rowDelta = targetRow - this.hardwareCursorRow;
			if (rowDelta > 0) this.terminal.write(`\x1b[${rowDelta}B`);
			else if (rowDelta < 0) this.terminal.write(`\x1b[${-rowDelta}A`);
			this.terminal.write("\r\n");
		} else {
			this.terminal.clearScreen();
		}
		this.started = false;
		this.terminal.showCursor();
		this.terminal.stop();
	}

	setFocus(component: Component | null): void {
		if (component === this.focusedComponent) return;
		if (isFocusable(this.focusedComponent)) this.focusedComponent.focused = false;
		this.focusedComponent = component;
		if (isFocusable(component)) component.focused = true;
		this.requestRender();
	}

	showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
		validateOverlayOptions(options);
		const entry: OverlayEntry = {
			component,
			options,
			preFocus: this.focusedComponent,
			hidden: false,
		};
		this.overlays.push(entry);
		if (!options.nonCapturing) this.setFocus(component);
		this.requestRender();
		let removed = false;

		return {
			hide: () => {
				if (removed) return;
				removed = true;
				this.removeOverlay(entry);
			},
			setHidden: (hidden) => {
				if (removed || entry.hidden === hidden) return;
				entry.hidden = hidden;
				if (hidden) {
					for (const overlay of this.overlays) {
						if (overlay.preFocus === component) overlay.preFocus = entry.preFocus;
					}
					if (this.focusedComponent === component) this.restoreOverlayFocus(entry);
				}
				if (!hidden && !entry.options.nonCapturing) {
					this.bringOverlayToFront(entry);
					this.setFocus(component);
				}
				this.requestRender();
			},
			isHidden: () => removed || entry.hidden,
			focus: () => {
				if (removed || entry.hidden) return;
				this.bringOverlayToFront(entry);
				this.setFocus(component);
				this.requestRender();
			},
			isFocused: () => !removed && !entry.hidden && this.focusedComponent === component,
		};
	}

	hideOverlay(): void {
		const overlay = [...this.overlays].reverse().find((entry) => !entry.hidden);
		if (overlay) this.removeOverlay(overlay);
	}

	hasOverlay(): boolean {
		return this.overlays.some((entry) => !entry.hidden);
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlays) overlay.component.invalidate();
	}

	override render(width: number): string[] {
		let lines = super.render(width);
		for (const overlay of this.overlays) {
			if (overlay.hidden) continue;
			lines = compositeOverlay(lines, overlay.component, overlay.options, width, this.terminal.rows);
		}
		return lines;
	}

	requestRender(force = false): void {
		if (!this.started) return;
		this.forcePending ||= force;
		this.renderRequested = true;
		if (force) {
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			queueMicrotask(() => this.flushRenderRequest());
			return;
		}
		queueMicrotask(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (!this.started || this.renderTimer || !this.renderRequested) return;
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.flushRenderRequest();
		}, delay);
	}

	private flushRenderRequest(): void {
		if (!this.started || !this.renderRequested) return;
		const shouldForce = this.forcePending;
		this.renderRequested = false;
		this.forcePending = false;
		this.lastRenderAt = performance.now();
		this.renderFrame(shouldForce);
		if (this.renderRequested) this.scheduleRender();
	}

	private handleTerminalInput(data: string): void {
		this.focusedComponent?.handleInput?.(data);
		this.requestRender();
	}

	private handleResize(): void {
		this.invalidate();
		this.requestRender(true);
	}

	private bringOverlayToFront(entry: OverlayEntry): void {
		const index = this.overlays.indexOf(entry);
		if (index < 0 || index === this.overlays.length - 1) return;
		this.overlays.splice(index, 1);
		this.overlays.push(entry);
	}

	private removeOverlay(entry: OverlayEntry): void {
		const index = this.overlays.indexOf(entry);
		if (index < 0) return;
		this.overlays.splice(index, 1);
		for (const overlay of this.overlays) {
			if (overlay.preFocus === entry.component) overlay.preFocus = entry.preFocus;
		}
		if (this.focusedComponent === entry.component) this.restoreOverlayFocus(entry);
		this.requestRender();
	}

	private restoreOverlayFocus(entry: OverlayEntry): void {
		const topCapturing = [...this.overlays]
			.reverse()
			.find((overlay) => !overlay.hidden && !overlay.options.nonCapturing && overlay !== entry);
		this.setFocus(topCapturing?.component ?? entry.preFocus);
	}

	private renderFrame(force: boolean, sourceLines?: string[]): void {
		const columns = this.terminal.columns;
		const rows = this.terminal.rows;
		const { lines, cursor } = this.prepareFrame(sourceLines ?? this.render(columns), columns);
		const firstFrame = this.previousColumns === 0;
		const widthChanged = !firstFrame && this.previousColumns !== columns;
		const heightChanged = !firstFrame && this.previousRows !== rows;
		const previousBufferLength = this.previousRows > 0 ? this.previousViewportTop + this.previousRows : rows;
		let previousViewportTop = heightChanged ? Math.max(0, previousBufferLength - rows) : this.previousViewportTop;
		let viewportTop = previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - previousViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		const finish = (finalHardwareCursorRow: number, finalViewportTop: number): void => {
			this.cursorRow = Math.max(0, lines.length - 1);
			this.hardwareCursorRow = finalHardwareCursorRow;
			this.previousViewportTop = finalViewportTop;
			this.previousLines = lines;
			this.previousColumns = columns;
			this.previousRows = rows;
			this.positionCursor(cursor, lines.length, rows);
		};

		if (firstFrame) {
			this.fullRender(lines, false, rows);
			finish(this.hardwareCursorRow, this.previousViewportTop);
			return;
		}
		if (force || widthChanged || heightChanged) {
			this.fullRender(lines, true, rows);
			finish(this.hardwareCursorRow, this.previousViewportTop);
			return;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const totalLines = Math.max(lines.length, this.previousLines.length);
		for (let row = 0; row < totalLines; row += 1) {
			if ((lines[row] ?? "") === (this.previousLines[row] ?? "")) continue;
			if (firstChanged < 0) firstChanged = row;
			lastChanged = row;
		}
		const appendedLines = lines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged < 0) firstChanged = this.previousLines.length;
			lastChanged = lines.length - 1;
		}
		const cursorChanged = !this.cursorsEqual(cursor, this.cursorPosition);
		if (firstChanged < 0) {
			this.previousRows = rows;
			if (cursorChanged) this.positionCursor(cursor, lines.length, rows);
			return;
		}

		if (firstChanged >= lines.length) {
			const targetRow = Math.max(0, lines.length - 1);
			const extraLines = this.previousLines.length - lines.length;
			if (targetRow < previousViewportTop || extraLines > rows) {
				this.fullRender(lines, true, rows);
				finish(this.hardwareCursorRow, this.previousViewportTop);
				return;
			}
			let output = SYNC_START;
			const lineDiff = computeLineDiff(targetRow);
			if (lineDiff > 0) output += `\x1b[${lineDiff}B`;
			else if (lineDiff < 0) output += `\x1b[${-lineDiff}A`;
			output += "\r";
			const clearStartOffset = lines.length === 0 ? 0 : 1;
			if (extraLines > 0 && clearStartOffset > 0) output += `\x1b[${clearStartOffset}B`;
			for (let index = 0; index < extraLines; index += 1) {
				output += "\r\x1b[2K";
				if (index < extraLines - 1) output += "\x1b[1B";
			}
			const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
			if (moveBack > 0) output += `\x1b[${moveBack}A`;
			output += SYNC_END;
			this.terminal.write(output);
			finish(targetRow, previousViewportTop);
			return;
		}

		if (firstChanged < previousViewportTop) {
			this.fullRender(lines, true, rows);
			finish(this.hardwareCursorRow, this.previousViewportTop);
			return;
		}

		let output = SYNC_START;
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;
		const previousViewportBottom = previousViewportTop + rows - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > previousViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(rows - 1, hardwareCursorRow - previousViewportTop));
			const moveToBottom = rows - 1 - currentScreenRow;
			if (moveToBottom > 0) output += `\x1b[${moveToBottom}B`;
			const scroll = moveTargetRow - previousViewportBottom;
			output += "\r\n".repeat(scroll);
			previousViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) output += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) output += `\x1b[${-lineDiff}A`;
		output += appendStart ? "\r\n" : "\r";

		const renderEnd = Math.min(lastChanged, lines.length - 1);
		for (let row = firstChanged; row <= renderEnd; row += 1) {
			if (row > firstChanged) output += "\r\n";
			output += `\x1b[2K${lines[row] ?? ""}`;
		}

		let finalCursorRow = renderEnd;
		if (this.previousLines.length > lines.length) {
			if (renderEnd < lines.length - 1) {
				const moveDown = lines.length - 1 - renderEnd;
				output += `\x1b[${moveDown}B`;
				finalCursorRow = lines.length - 1;
			}
			const extraLines = this.previousLines.length - lines.length;
			for (let row = lines.length; row < this.previousLines.length; row += 1) output += "\r\n\x1b[2K";
			if (extraLines > 0) output += `\x1b[${extraLines}A`;
		}
		output += SYNC_END;
		this.terminal.write(output);
		finish(finalCursorRow, Math.max(previousViewportTop, finalCursorRow - rows + 1));
	}

	private prepareFrame(sourceLines: string[], width: number): PreparedFrame {
		let cursor: CursorPosition | null = null;
		const lines = sourceLines.map((sourceLine, index) => {
			if (sourceLine.includes("\n") || sourceLine.includes("\r")) {
				throw new Error(`Component line ${index + 1} contains a line break`);
			}

			let line = sourceLine;
			let markerIndex = line.indexOf(CURSOR_MARKER);
			while (markerIndex >= 0) {
				if (cursor) throw new Error("Frame contains more than one cursor marker");
				cursor = { row: index, column: visibleWidth(line.slice(0, markerIndex)) };
				line = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = line.indexOf(CURSOR_MARKER);
			}

			const lineWidth = visibleWidth(line);
			if (lineWidth > width) {
				throw new Error(`Component line ${index + 1} is ${lineWidth} columns wide, maximum is ${width}`);
			}
			return `${line}${LINE_RESET}`;
		});
		return { lines, cursor };
	}

	private fullRender(lines: string[], clear: boolean, rows: number): void {
		let output = SYNC_START;
		if (clear) output += `\x1b[2J\x1b[H${CLEAR_SCROLLBACK}`;
		output += lines.join("\r\n");
		output += SYNC_END;
		this.terminal.write(output);
		this.cursorRow = Math.max(0, lines.length - 1);
		this.hardwareCursorRow = this.cursorRow;
		this.previousViewportTop = Math.max(0, Math.max(rows, lines.length) - rows);
	}

	private positionCursor(cursor: CursorPosition | null, lineCount: number, rows: number): void {
		this.cursorPosition = cursor;
		if (!cursor) {
			this.terminal.hideCursor();
			return;
		}
		const viewportEnd = this.previousViewportTop + rows - 1;
		if (cursor.row < this.previousViewportTop || cursor.row > viewportEnd || cursor.row >= lineCount) {
			this.terminal.hideCursor();
			return;
		}
		const rowDelta = cursor.row - this.hardwareCursorRow;
		let output = "";
		if (rowDelta > 0) output += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) output += `\x1b[${-rowDelta}A`;
		output += "\r";
		if (cursor.column > 0) output += `\x1b[${cursor.column}C`;
		this.terminal.write(output);
		this.hardwareCursorRow = cursor.row;
		this.terminal.showCursor();
	}

	private cursorsEqual(left: CursorPosition | null, right: CursorPosition | null): boolean {
		return left?.row === right?.row && left?.column === right?.column;
	}
}
