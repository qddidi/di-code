import type { Terminal } from "../src/terminal.ts";

export class VirtualTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private started = false;
	private readonly writes: string[] = [];
	private currentColumns: number;
	private currentRows: number;

	constructor(columns = 80, rows = 24) {
		this.assertDimensions(columns, rows);
		this.currentColumns = columns;
		this.currentRows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.started) throw new Error("Terminal is already started");
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.write("\x1b[?2004h");
	}

	stop(): void {
		if (!this.started) return;
		this.write("\x1b[?2004l");
		this.started = false;
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.currentColumns;
	}

	get rows(): number {
		return this.currentRows;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		const safeTitle = Array.from(title)
			.filter((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint >= 0x20 && codePoint !== 0x7f;
			})
			.join("");
		this.write(`\x1b]0;${safeTitle}\x07`);
	}

	sendInput(data: string): void {
		if (this.started) this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this.assertDimensions(columns, rows);
		if (columns === this.currentColumns && rows === this.currentRows) return;
		this.currentColumns = columns;
		this.currentRows = rows;
		this.notifyResize();
	}

	notifyResize(): void {
		if (this.started) this.resizeHandler?.();
	}

	get output(): string {
		return this.writes.join("");
	}

	clearOutput(): void {
		this.writes.length = 0;
	}

	private assertDimensions(columns: number, rows: number): void {
		if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(rows) || rows <= 0) {
			throw new Error("Terminal dimensions must be positive integers");
		}
	}
}
