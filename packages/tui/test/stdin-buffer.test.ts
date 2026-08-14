import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { StdinBuffer } from "../src/stdin-buffer.ts";

function createBuffer(timeoutMs = 10) {
	const received: string[] = [];
	const buffer = new StdinBuffer({
		timeoutMs,
		onData: (data) => received.push(data),
	});
	return { buffer, received };
}

describe("StdinBuffer", () => {
	it("forwards ordinary Unicode text without splitting Unicode code points", () => {
		const { buffer, received } = createBuffer();

		buffer.process("ab世界");

		assert.deepEqual(received, ["ab世界"]);
	});

	it("reassembles a CSI sequence split across chunks", () => {
		const { buffer, received } = createBuffer();

		buffer.process("\x1b[");
		assert.deepEqual(received, []);
		buffer.process("A");

		assert.deepEqual(received, ["\x1b[A"]);
	});

	it("reassembles an SS3 sequence split across chunks", () => {
		const { buffer, received } = createBuffer();

		buffer.process("\x1bO");
		buffer.process("P");

		assert.deepEqual(received, ["\x1bOP"]);
	});

	it("reassembles a bracketed paste split across chunks", () => {
		const { buffer, received } = createBuffer();

		buffer.process("\x1b[200");
		assert.deepEqual(received, []);
		buffer.process("~hello ");
		buffer.process("世界\x1b[201~");

		assert.deepEqual(received, ["\x1b[200~hello 世界\x1b[201~"]);
	});

	it("reassembles a bracketed paste whose end marker is split across chunks", () => {
		const { buffer, received } = createBuffer();

		buffer.process("\x1b[200~hello\x1b[20");
		assert.deepEqual(received, []);
		buffer.process("1~");

		assert.deepEqual(received, ["\x1b[200~hello\x1b[201~"]);
	});

	it("flushes an incomplete escape sequence explicitly", () => {
		const { buffer, received } = createBuffer();

		buffer.process("\x1b[1;");
		buffer.flush();

		assert.deepEqual(received, ["\x1b[1;"]);
	});

	it("destroy discards buffered input and cancels later delivery", () => {
		const { buffer, received } = createBuffer();

		buffer.process("\x1b[");
		buffer.destroy();
		buffer.process("A");

		assert.deepEqual(received, []);
	});
});
