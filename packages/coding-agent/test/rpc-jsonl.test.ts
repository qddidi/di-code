import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonlLineDecoder, serializeJsonLine } from "../src/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	it("splits only on LF and preserves Unicode separators across chunks", () => {
		const lines: string[] = [];
		const decoder = new JsonlLineDecoder((line) => lines.push(line));
		const record = serializeJsonLine({ text: "a\u2028b\u2029c" });
		const bytes = Buffer.from(record);

		decoder.push(bytes.subarray(0, 5));
		decoder.push(bytes.subarray(5));
		decoder.end();

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({ text: "a\u2028b\u2029c" });
	});

	it("accepts CRLF and emits a final unterminated line", () => {
		const lines: string[] = [];
		const decoder = new JsonlLineDecoder((line) => lines.push(line));
		decoder.push(Buffer.from('{"a":1}\r\n{"b":2}'));
		decoder.end();

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("rejects a line larger than the configured byte limit", () => {
		const decoder = new JsonlLineDecoder(() => undefined, { maxLineBytes: 8 });

		expect(() => decoder.push(Buffer.from("123456789"))).toThrow("RPC JSONL line exceeds 8 bytes");
	});

	it("can frame records read from a Node stream", async () => {
		const stream = Readable.from([serializeJsonLine({ one: 1 }), serializeJsonLine({ two: 2 })]);
		const lines: string[] = [];
		const decoder = new JsonlLineDecoder((line) => lines.push(line));

		for await (const chunk of stream) decoder.push(chunk);
		decoder.end();

		expect(lines.map((line) => JSON.parse(line))).toEqual([{ one: 1 }, { two: 2 }]);
	});
});
