import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "vitest";
import { ProcessTerminal } from "../src/terminal.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FakeInput extends EventEmitter {
	isRaw = false;
	encoding?: BufferEncoding;
	resumed = false;
	paused = false;
	setRawModeCalls: boolean[] = [];

	setRawMode(value: boolean): void {
		this.setRawModeCalls.push(value);
		this.isRaw = value;
	}

	setEncoding(encoding: BufferEncoding): this {
		this.encoding = encoding;
		return this;
	}

	resume(): this {
		this.resumed = true;
		this.paused = false;
		return this;
	}

	pause(): this {
		this.paused = true;
		this.resumed = false;
		return this;
	}
}

class FakeOutput extends EventEmitter {
	columns?: number;
	rows?: number;
	writes: string[] = [];

	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}
}

function createProcessTerminal(options: { columns?: number; rows?: number; env?: NodeJS.ProcessEnv } = {}) {
	const input = new FakeInput();
	const output = new FakeOutput();
	output.columns = options.columns;
	output.rows = options.rows;
	const terminal = new ProcessTerminal({
		input: input as unknown as NodeJS.ReadStream,
		output: output as unknown as NodeJS.WriteStream,
		env: options.env ?? {},
	});
	return { input, output, terminal };
}

describe("ProcessTerminal dimensions", () => {
	it("prefers output dimensions", () => {
		const { terminal } = createProcessTerminal({ columns: 100, rows: 40, env: { COLUMNS: "5", LINES: "6" } });
		assert.equal(terminal.columns, 100);
		assert.equal(terminal.rows, 40);
	});

	it("uses valid environment dimensions and then 80x24 defaults", () => {
		const fromEnv = createProcessTerminal({ env: { COLUMNS: "120", LINES: "50" } }).terminal;
		assert.equal(fromEnv.columns, 120);
		assert.equal(fromEnv.rows, 50);

		const fallback = createProcessTerminal({ env: { COLUMNS: "0", LINES: "nope" } }).terminal;
		assert.equal(fallback.columns, 80);
		assert.equal(fallback.rows, 24);
	});
});

describe("ProcessTerminal lifecycle", () => {
	it("starts, forwards input, and enables bracketed paste", () => {
		const { input, output, terminal } = createProcessTerminal();
		const received: string[] = [];
		terminal.start(
			(data) => received.push(data),
			() => {},
		);

		assert.deepEqual(input.setRawModeCalls, [true]);
		assert.equal(input.encoding, "utf8");
		assert.equal(input.resumed, true);
		assert.equal(output.writes[0], "\x1b[?2004h");
		input.emit("data", Buffer.from("hello"));
		assert.deepEqual(received, ["hello"]);
	});

	it("propagates resize and stop restores state", () => {
		const { input, output, terminal } = createProcessTerminal();
		let resizeCount = 0;
		terminal.start(
			() => {},
			() => {
				resizeCount += 1;
			},
		);
		output.emit("resize");
		assert.equal(resizeCount, 1);

		terminal.stop();
		assert.deepEqual(input.setRawModeCalls, [true, false]);
		assert.equal(input.paused, true);
		assert.equal(output.writes.at(-1), "\x1b[?2004l");
		output.emit("resize");
		assert.equal(resizeCount, 1);
	});

	it("rejects duplicate start and makes stop idempotent", () => {
		const { terminal } = createProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		assert.throws(
			() =>
				terminal.start(
					() => {},
					() => {},
				),
			{ message: "Terminal is already started" },
		);
		terminal.stop();
		terminal.stop();
	});

	it("ignores late input after stop", () => {
		const { input, terminal } = createProcessTerminal();
		const received: string[] = [];
		terminal.start(
			(data) => received.push(data),
			() => {},
		);
		terminal.stop();
		input.emit("data", "late");
		assert.deepEqual(received, []);
	});
});

describe("ProcessTerminal controls", () => {
	it("writes cursor, movement, and clear sequences", () => {
		const { output, terminal } = createProcessTerminal();
		terminal.moveBy(3);
		terminal.moveBy(-2);
		terminal.moveBy(0);
		terminal.hideCursor();
		terminal.showCursor();
		terminal.clearLine();
		terminal.clearFromCursor();
		terminal.clearScreen();
		assert.equal(output.writes.join(""), "\x1b[3B\x1b[2A\x1b[?25l\x1b[?25h\x1b[K\x1b[J\x1b[2J\x1b[H");
	});

	it("filters controls from the title", () => {
		const { output, terminal } = createProcessTerminal();
		terminal.setTitle("safe\x07\x1b]2;bad\n");
		assert.equal(output.writes[0], "\x1b]0;safe]2;bad\x07");
	});
});

describe("VirtualTerminal", () => {
	it("starts and stops with bracketed paste sequences", () => {
		const terminal = new VirtualTerminal(40, 10);
		terminal.start(
			() => {},
			() => {},
		);
		terminal.stop();
		assert.equal(terminal.output, "\x1b[?2004h\x1b[?2004l");
	});

	it("only forwards input while started", () => {
		const terminal = new VirtualTerminal();
		const received: string[] = [];
		terminal.sendInput("before");
		terminal.start(
			(data) => received.push(data),
			() => {},
		);
		terminal.sendInput("during");
		terminal.stop();
		terminal.sendInput("after");
		assert.deepEqual(received, ["during"]);
	});

	it("updates dimensions and propagates real changes", () => {
		const terminal = new VirtualTerminal(80, 24);
		let resizeCount = 0;
		terminal.start(
			() => {},
			() => {
				resizeCount += 1;
			},
		);
		terminal.resize(100, 30);
		terminal.resize(100, 30);
		assert.equal(terminal.columns, 100);
		assert.equal(terminal.rows, 30);
		assert.equal(resizeCount, 1);
	});

	it("matches control output and rejects invalid dimensions", () => {
		const terminal = new VirtualTerminal();
		terminal.moveBy(2);
		terminal.moveBy(-1);
		terminal.hideCursor();
		terminal.showCursor();
		terminal.clearLine();
		terminal.clearFromCursor();
		terminal.clearScreen();
		terminal.setTitle("demo");
		assert.equal(terminal.output, "\x1b[2B\x1b[1A\x1b[?25l\x1b[?25h\x1b[K\x1b[J\x1b[2J\x1b[H\x1b]0;demo\x07");
		assert.throws(() => terminal.resize(0, 24), { message: "Terminal dimensions must be positive integers" });
	});
});
