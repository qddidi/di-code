import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../src/index.ts";
import { createFauxProvider } from "../src/index.ts";

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("createFauxProvider", () => {
	it("streams fixed-size text chunks and resolves the final message", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "text", text: "hello" }],
				},
			],
			chunkSize: 2,
			now: () => 1234,
		});

		const stream = faux.provider.stream(faux.model, { messages: [] });
		const events = await collectEvents(stream);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(
			events
				.filter((event) => event.type === "text_delta")
				.map((event) => event.delta)
				.join(""),
		).toBe("hello");

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("done");
		if (terminal?.type !== "done") {
			throw new Error("Expected done event");
		}
		expect(terminal.message).toMatchObject({
			provider: "faux",
			model: "faux-model",
			timestamp: 1234,
			stopReason: "stop",
			content: [{ type: "text", text: "hello" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			},
		});
		await expect(stream.result()).resolves.toEqual(terminal.message);
	});

	it("consumes responses in FIFO order when stream is called", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first" }] },
				{ type: "success", content: [{ type: "text", text: "second" }] },
			],
			now: () => 1500,
		});

		expect(faux.pendingResponses()).toBe(2);
		const firstStream = faux.provider.stream(faux.model, { messages: [] });
		expect(faux.pendingResponses()).toBe(1);
		const secondStream = faux.provider.stream(faux.model, { messages: [] });
		expect(faux.pendingResponses()).toBe(0);

		await expect(firstStream.result()).resolves.toMatchObject({
			content: [{ type: "text", text: "first" }],
		});
		await expect(secondStream.result()).resolves.toMatchObject({
			content: [{ type: "text", text: "second" }],
		});
	});
	it("streams thinking and tool argument JSON in content order", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "read it" },
						{
							type: "tool_call",
							id: "call-1",
							name: "read",
							arguments: { path: "README.md" },
						},
					],
				},
			],
			chunkSize: 3,
			now: () => 2000,
		});

		const stream = faux.provider.stream(faux.model, { messages: [] });
		const events = await collectEvents(stream);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_end",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_end",
			"done",
		]);

		const argumentJson = events
			.filter((event) => event.type === "tool_call_delta")
			.map((event) => event.argumentsDelta)
			.join("");
		expect(JSON.parse(argumentJson)).toEqual({ path: "README.md" });

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("done");
		if (terminal?.type === "done") {
			expect(terminal.reason).toBe("tool_use");
			expect(terminal.message.stopReason).toBe("tool_use");
		}
	});

	it("rejects a scripted stop reason that contradicts its content", () => {
		expect(() =>
			createFauxProvider({
				responses: [
					{
						type: "success",
						content: [
							{
								type: "tool_call",
								id: "call-1",
								name: "read",
								arguments: {},
							},
						],
						stopReason: "stop",
					},
				],
			}),
		).toThrow("tool_call content requires stopReason tool_use");

		expect(() =>
			createFauxProvider({
				responses: [
					{
						type: "success",
						content: [{ type: "text", text: "done" }],
						stopReason: "tool_use",
					},
				],
			}),
		).toThrow("stopReason tool_use requires tool_call content");
	});
	it("emits a protocol error for a scripted failure", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "failure", errorMessage: "model failed" }],
			now: () => 4000,
		});
		const stream = faux.provider.stream(faux.model, { messages: [] });
		const events = await collectEvents(stream);

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") {
			throw new Error("Expected error event");
		}
		expect(terminal.reason).toBe("error");
		expect(terminal.message).toMatchObject({
			stopReason: "error",
			errorMessage: "model failed",
			timestamp: 4000,
			content: [],
		});
		await expect(stream.result()).resolves.toEqual(terminal.message);
	});

	it("returns a deterministic failure when the response queue is empty", async () => {
		const faux = createFauxProvider({ responses: [], now: () => 5000 });
		const stream = faux.provider.stream(faux.model, { messages: [] });
		const events = await collectEvents(stream);

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "No faux response scripted",
		});
	});
	it("emits start then aborted error for a pre-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort("do not expose this reason");
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "hello" }] }],
			now: () => 6000,
		});

		const stream = faux.provider.stream(faux.model, { messages: [] }, { signal: controller.signal });
		const events = await collectEvents(stream);

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "aborted",
			errorMessage: "Faux request aborted",
			content: [],
		});
		await expect(stream.result()).resolves.not.toMatchObject({
			errorMessage: expect.stringContaining("do not expose"),
		});
	});

	it("stops after the first text delta and preserves partial text", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "abcdef" }] }],
			chunkSize: 2,
			now: () => 7000,
		});
		const stream = faux.provider.stream(faux.model, { messages: [] }, { signal: controller.signal });
		const events: StreamEvent[] = [];

		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_delta") {
				controller.abort();
			}
		}

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "aborted",
			content: [{ type: "text", text: "ab" }],
		});
	});

	it("omits an incomplete tool call when aborted during argument deltas", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "call-1",
							name: "read",
							arguments: { path: "README.md" },
						},
					],
				},
			],
			chunkSize: 2,
			now: () => 8000,
		});
		const stream = faux.provider.stream(faux.model, { messages: [] }, { signal: controller.signal });
		const events: StreamEvent[] = [];

		for await (const event of stream) {
			events.push(event);
			if (event.type === "tool_call_delta") {
				controller.abort();
			}
		}

		expect(events.map((event) => event.type)).toEqual(["start", "tool_call_start", "tool_call_delta", "error"]);
		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "aborted",
			content: [],
		});
	});

	it("does not consume or cancel the next queued response", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "cancel me" }] },
				{ type: "success", content: [{ type: "text", text: "next" }] },
			],
			chunkSize: 2,
			now: () => 9000,
		});

		const cancelled = faux.provider.stream(faux.model, { messages: [] }, { signal: controller.signal });
		for await (const event of cancelled) {
			if (event.type === "text_delta") {
				controller.abort();
			}
		}
		expect(faux.pendingResponses()).toBe(1);

		const next = faux.provider.stream(faux.model, { messages: [] });
		await expect(next.result()).resolves.toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "next" }],
		});
	});
});
