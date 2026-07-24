import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.js";

type TestEvent = { type: "value"; value: number } | { type: "done"; result: number };

function createTestStream(): EventStream<TestEvent, number> {
	return new EventStream<TestEvent, number>({
		validate(event) {
			if (event.type === "value" && event.value < 0) {
				throw new Error("Negative values are invalid");
			}
		},
		isTerminal(event) {
			return event.type === "done";
		},
		getResult(event) {
			if (event.type !== "done") {
				throw new Error("Expected terminal event");
			}
			return event.result;
		},
	});
}

async function collectEvents<TEvent>(stream: AsyncIterable<TEvent>): Promise<TEvent[]> {
	const events: TEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("EventStream", () => {
	it("buffers producer events and exposes the terminal result", async () => {
		const stream = createTestStream();

		stream.push({ type: "value", value: 1 });
		stream.push({ type: "value", value: 2 });
		stream.push({ type: "done", result: 3 });

		await expect(collectEvents(stream)).resolves.toEqual([
			{ type: "value", value: 1 },
			{ type: "value", value: 2 },
			{ type: "done", result: 3 },
		]);
		await expect(stream.result()).resolves.toBe(3);
	});

	it("wakes a consumer that is already waiting", async () => {
		const stream = createTestStream();
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = iterator.next();

		queueMicrotask(() => {
			stream.push({ type: "value", value: 7 });
			stream.push({ type: "done", result: 7 });
		});

		await expect(firstEvent).resolves.toEqual({
			value: { type: "value", value: 7 },
			done: false,
		});
		await expect(iterator.next()).resolves.toEqual({
			value: { type: "done", result: 7 },
			done: false,
		});
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
	});

	it("finishes additional pending next calls after the terminal event", async () => {
		const stream = createTestStream();
		const iterator = stream[Symbol.asyncIterator]();
		const terminalEvent = iterator.next();
		const afterTerminal = iterator.next();

		stream.push({ type: "done", result: 5 });

		await expect(terminalEvent).resolves.toEqual({
			value: { type: "done", result: 5 },
			done: false,
		});
		await expect(afterTerminal).resolves.toEqual({ value: undefined, done: true });
	});

	it("keeps result pending until the terminal event arrives", async () => {
		const stream = createTestStream();
		let settled = false;
		const result = stream.result().then((value) => {
			settled = true;
			return value;
		});

		await Promise.resolve();
		expect(settled).toBe(false);

		stream.push({ type: "done", result: 9 });

		await expect(result).resolves.toBe(9);
		expect(settled).toBe(true);
	});

	it("rejects events after a terminal event", () => {
		const stream = createTestStream();
		stream.push({ type: "done", result: 1 });

		expect(() => stream.push({ type: "value", value: 2 })).toThrow("EventStream is already settled");
	});

	it("rejects the iterator and result when the producer fails", async () => {
		const stream = createTestStream();
		const iterator = stream[Symbol.asyncIterator]();
		const nextEvent = iterator.next();
		const result = stream.result();
		const failure = new Error("producer failed");

		stream.fail(failure);

		await expect(nextEvent).rejects.toBe(failure);
		await expect(result).rejects.toBe(failure);
	});

	it("turns a validation exception into a failed stream", async () => {
		const stream = createTestStream();
		const iterator = stream[Symbol.asyncIterator]();
		const result = stream.result();

		expect(() => stream.push({ type: "value", value: -1 })).toThrow("Negative values are invalid");
		await expect(iterator.next()).rejects.toThrow("Negative values are invalid");
		await expect(result).rejects.toThrow("Negative values are invalid");
	});

	it("rejects a second async iterator", async () => {
		const stream = createTestStream();
		const firstIterator = stream[Symbol.asyncIterator]();

		expect(() => stream[Symbol.asyncIterator]()).toThrow("EventStream supports exactly one async iterator");

		stream.push({ type: "done", result: 1 });
		await expect(firstIterator.next()).resolves.toEqual({
			value: { type: "done", result: 1 },
			done: false,
		});
		await expect(firstIterator.next()).resolves.toEqual({ value: undefined, done: true });
	});
});
