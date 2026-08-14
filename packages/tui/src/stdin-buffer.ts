const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export interface StdinBufferOptions {
	readonly timeoutMs?: number;
	readonly onData: (data: string) => void;
}

function isFinalControlCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint >= 0x40 && codePoint <= 0x7e;
}

function firstCodePoint(value: string): string {
	return Array.from(value)[0] ?? "";
}

function isPrefix(value: string, expected: string): boolean {
	return value.length > 0 && expected.startsWith(value);
}

export class StdinBuffer {
	private readonly timeoutMs: number;
	private buffer = "";
	private pasteBuffer = "";
	private inPaste = false;
	private flushTimer?: ReturnType<typeof setTimeout>;
	private destroyed = false;
	private readonly options: StdinBufferOptions;

	constructor(options: StdinBufferOptions) {
		this.options = options;
		const timeoutMs = options.timeoutMs ?? 25;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
			throw new Error("StdinBuffer timeoutMs must be a positive integer");
		}
		this.timeoutMs = timeoutMs;
	}

	process(data: string | Buffer): void {
		if (this.destroyed) return;
		const chunk = typeof data === "string" ? data : data.toString("utf8");
		if (chunk.length === 0) return;
		this.buffer += chunk;
		this.drain();
	}

	flush(): void {
		if (this.destroyed || this.inPaste) return;
		this.clearFlushTimer();
		if (this.buffer.length === 0) return;
		const buffered = this.buffer;
		this.buffer = "";
		this.emit(buffered);
	}

	destroy(): void {
		this.destroyed = true;
		this.clearFlushTimer();
		this.buffer = "";
		this.pasteBuffer = "";
		this.inPaste = false;
	}

	private drain(): void {
		while (!this.destroyed) {
			if (this.inPaste) {
				const endIndex = this.buffer.indexOf(PASTE_END);
				if (endIndex < 0) {
					let markerPrefixLength = Math.min(this.buffer.length, PASTE_END.length - 1);
					while (markerPrefixLength > 0 && !PASTE_END.startsWith(this.buffer.slice(-markerPrefixLength))) {
						markerPrefixLength -= 1;
					}
					const safeContentLength = this.buffer.length - markerPrefixLength;
					this.pasteBuffer += this.buffer.slice(0, safeContentLength);
					this.buffer = this.buffer.slice(safeContentLength);
					return;
				}

				const content = this.pasteBuffer + this.buffer.slice(0, endIndex);
				this.buffer = this.buffer.slice(endIndex + PASTE_END.length);
				this.pasteBuffer = "";
				this.inPaste = false;
				this.emit(`${PASTE_START}${content}${PASTE_END}`);
				continue;
			}

			if (this.buffer.startsWith(PASTE_START)) {
				this.buffer = this.buffer.slice(PASTE_START.length);
				this.inPaste = true;
				continue;
			}

			if (this.buffer !== ESC && isPrefix(this.buffer, PASTE_START)) {
				this.clearFlushTimer();
				return;
			}

			if (this.buffer.length === 0) {
				this.clearFlushTimer();
				return;
			}

			const first = firstCodePoint(this.buffer);
			if (first !== ESC) {
				const escapeIndex = this.buffer.indexOf(ESC);
				const text = escapeIndex < 0 ? this.buffer : this.buffer.slice(0, escapeIndex);
				this.buffer = escapeIndex < 0 ? "" : this.buffer.slice(escapeIndex);
				this.emit(text);
				continue;
			}

			if (this.buffer === ESC) {
				this.scheduleFlush();
				return;
			}

			const codePoints = Array.from(this.buffer);
			const second = codePoints[1] ?? "";
			if (second === "[" || second === "O") {
				const finalIndex = codePoints.findIndex((character, index) => index >= 2 && isFinalControlCharacter(character));
				if (finalIndex < 0) {
					this.scheduleFlush();
					return;
				}

				const sequence = codePoints.slice(0, finalIndex + 1).join("");
				this.buffer = codePoints.slice(finalIndex + 1).join("");
				this.emit(sequence);
				continue;
			}

			if (second === ESC) {
				this.buffer = codePoints.slice(1).join("");
				this.emit(ESC);
				continue;
			}

			this.buffer = codePoints.slice(2).join("");
			this.emit(`${ESC}${second}`);
		}
	}

	private emit(data: string): void {
		if (data.length > 0 && !this.destroyed) this.options.onData(data);
	}

	private scheduleFlush(): void {
		this.clearFlushTimer();
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, this.timeoutMs);
	}

	private clearFlushTimer(): void {
		if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}
}
