import { StringDecoder } from "node:string_decoder";

export const DEFAULT_RPC_MAX_LINE_BYTES = 1_048_576;

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export class JsonlLineDecoder {
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private readonly maxLineBytes: number;
	private readonly onLine: (line: string) => void;

	constructor(onLine: (line: string) => void, options: { readonly maxLineBytes?: number } = {}) {
		this.onLine = onLine;
		this.maxLineBytes = options.maxLineBytes ?? DEFAULT_RPC_MAX_LINE_BYTES;
		if (!Number.isInteger(this.maxLineBytes) || this.maxLineBytes <= 0) {
			throw new RangeError("maxLineBytes must be a positive integer");
		}
	}

	push(chunk: string | Uint8Array): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
		this.emitCompleteLines();
		this.assertLineLimit(this.buffer);
	}

	end(): void {
		this.buffer += this.decoder.end();
		this.emitCompleteLines();
		if (this.buffer.length === 0) return;
		this.assertLineLimit(this.buffer);
		this.emit(this.buffer);
		this.buffer = "";
	}

	private emitCompleteLines(): void {
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = this.buffer.slice(0, newlineIndex);
			this.assertLineLimit(line);
			this.emit(line);
			this.buffer = this.buffer.slice(newlineIndex + 1);
		}
	}

	private emit(line: string): void {
		this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	}

	private assertLineLimit(line: string): void {
		if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
			throw new RangeError(`RPC JSONL line exceeds ${this.maxLineBytes} bytes`);
		}
	}
}
