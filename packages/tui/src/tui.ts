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
	private readonly terminal: Terminal;
	private previousLines: string[] = [];
	private previousColumns = 0;
	private previousRows = 0;
	private focusedComponent: Component | null = null;
	private cursorPosition: CursorPosition | null = null;
	private hardwareRow = 0;
	private started = false;
	private renderPending = false;
	private forcePending = false;
	private readonly overlays: OverlayEntry[] = [];

	constructor(terminal: Terminal) {
		super();
		this.terminal = terminal;
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
			this.renderFrame(true);
		} catch (error) {
			this.started = false;
			this.terminal.showCursor();
			this.terminal.stop();
			throw error;
		}
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.renderPending = false;
		this.forcePending = false;
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
		if (this.renderPending) return;
		this.renderPending = true;
		queueMicrotask(() => {
			if (!this.started || !this.renderPending) return;
			const shouldForce = this.forcePending;
			this.renderPending = false;
			this.forcePending = false;
			this.renderFrame(shouldForce);
		});
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

	private renderFrame(force: boolean): void {
		const columns = this.terminal.columns;
		const rows = this.terminal.rows;
		const { lines, cursor } = this.prepareFrame(this.render(columns), columns);
		const firstFrame = this.previousColumns === 0;
		const sizeChanged = !firstFrame && (this.previousColumns !== columns || this.previousRows !== rows);
		const frameChanged = !this.framesEqual(lines, this.previousLines);
		const cursorChanged = !this.cursorsEqual(cursor, this.cursorPosition);

		if (force || firstFrame || sizeChanged) {
			this.fullRender(lines);
		} else if (frameChanged) {
			this.differentialRender(lines);
		}

		this.previousLines = lines;
		this.previousColumns = columns;
		this.previousRows = rows;
		if (force || firstFrame || sizeChanged || frameChanged || cursorChanged) {
			this.positionCursor(cursor);
		}
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

	private fullRender(lines: string[]): void {
		this.terminal.clearScreen();
		this.terminal.write(`${SYNC_START}${lines.join("\r\n")}${SYNC_END}`);
		this.hardwareRow = Math.max(0, lines.length - 1);
	}

	private differentialRender(lines: string[]): void {
		const totalRows = Math.max(lines.length, this.previousLines.length);
		let firstChanged = -1;
		let lastChanged = -1;

		for (let row = 0; row < totalRows; row += 1) {
			if ((lines[row] ?? "") === (this.previousLines[row] ?? "")) continue;
			if (firstChanged < 0) firstChanged = row;
			lastChanged = row;
		}
		if (firstChanged < 0) return;

		let output = SYNC_START;
		output += this.moveRows(this.hardwareRow, firstChanged);
		for (let row = firstChanged; row <= lastChanged; row += 1) {
			if (row > firstChanged) output += "\x1b[1B";
			output += `\r\x1b[2K${lines[row] ?? ""}`;
		}
		output += SYNC_END;
		this.terminal.write(output);
		this.hardwareRow = lastChanged;
	}

	private positionCursor(cursor: CursorPosition | null): void {
		this.cursorPosition = cursor;
		if (!cursor) return;
		let output = this.moveRows(this.hardwareRow, cursor.row);
		output += "\r";
		if (cursor.column > 0) output += `\x1b[${cursor.column}C`;
		this.terminal.write(output);
		this.hardwareRow = cursor.row;
	}

	private moveRows(from: number, to: number): string {
		if (to > from) return `\x1b[${to - from}B`;
		if (to < from) return `\x1b[${from - to}A`;
		return "";
	}

	private framesEqual(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((line, index) => line === right[index]);
	}

	private cursorsEqual(left: CursorPosition | null, right: CursorPosition | null): boolean {
		return left?.row === right?.row && left?.column === right?.column;
	}
}
