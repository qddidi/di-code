const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	setTitle(title: string): void;
}

export interface ProcessTerminalOptions {
	readonly input?: NodeJS.ReadStream;
	readonly output?: NodeJS.WriteStream;
	readonly env?: NodeJS.ProcessEnv;
}

function parseDimension(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

function sanitizeTitle(title: string): string {
	return Array.from(title)
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 0x20 && codePoint !== 0x7f;
		})
		.join("");
}

export class ProcessTerminal implements Terminal {
	private readonly input: NodeJS.ReadStream;
	private readonly output: NodeJS.WriteStream;
	private readonly env: NodeJS.ProcessEnv;
	private started = false;
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;

	private readonly handleData = (data: string | Buffer): void => {
		if (!this.started || !this.inputHandler) return;
		this.inputHandler(typeof data === "string" ? data : data.toString("utf8"));
	};

	private readonly handleResize = (): void => {
		if (this.started) this.resizeHandler?.();
	};

	constructor(options: ProcessTerminalOptions = {}) {
		this.input = options.input ?? process.stdin;
		this.output = options.output ?? process.stdout;
		this.env = options.env ?? process.env;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.started) throw new Error("Terminal is already started");
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.wasRaw = Boolean(this.input.isRaw);
		this.input.setRawMode?.(true);
		this.input.setEncoding("utf8");
		this.input.resume();
		this.input.on("data", this.handleData);
		this.output.on("resize", this.handleResize);
		this.write(BRACKETED_PASTE_ENABLE);
	}

	stop(): void {
		if (!this.started) return;
		this.write(BRACKETED_PASTE_DISABLE);
		this.input.removeListener("data", this.handleData);
		this.output.removeListener("resize", this.handleResize);
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.input.pause();
		this.input.setRawMode?.(this.wasRaw);
		this.started = false;
	}

	write(data: string): void {
		this.output.write(data);
	}

	get columns(): number {
		return parseDimension(this.output.columns, parseDimension(this.env.COLUMNS, DEFAULT_COLUMNS));
	}

	get rows(): number {
		return parseDimension(this.output.rows, parseDimension(this.env.LINES, DEFAULT_ROWS));
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
		this.write(`\x1b]0;${sanitizeTitle(title)}\x07`);
	}
}
