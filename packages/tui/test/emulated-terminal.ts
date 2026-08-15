import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "../src/terminal.ts";

const XtermTerminal = xterm.Terminal;

export class EmulatedTerminal implements Terminal {
	private readonly terminal: XtermTerminalType;
	private readonly ignoreClearScrollback: boolean;
	private started = false;
	readonly columns: number;
	readonly rows: number;

	constructor(columns: number, rows: number, options: { readonly ignoreClearScrollback?: boolean } = {}) {
		this.columns = columns;
		this.rows = rows;
		this.ignoreClearScrollback = options.ignoreClearScrollback ?? false;
		this.terminal = new XtermTerminal({
			allowProposedApi: true,
			cols: columns,
			rows,
			scrollback: 100,
		});
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {
		this.started = true;
		this.write("\x1b[?2004h");
	}

	stop(): void {
		if (!this.started) return;
		this.write("\x1b[?2004l");
		this.started = false;
	}

	write(data: string): void {
		this.terminal.write(this.ignoreClearScrollback ? data.replaceAll("\x1b[3J", "") : data);
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
		this.write(`\x1b]0;${title}\x07`);
	}

	async flush(): Promise<void> {
		await new Promise<void>((resolve) => this.terminal.write("", resolve));
	}

	getScrollBuffer(): string[] {
		const buffer = this.terminal.buffer.active;
		return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "");
	}

	getViewport(): string[] {
		const buffer = this.terminal.buffer.active;
		return Array.from(
			{ length: this.rows },
			(_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
		);
	}
}
