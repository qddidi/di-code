import { describe, expect, it, vi } from "vitest";
import type {
	Context,
	Model,
	OpenAIResponsesDependencies,
	OpenAIResponsesStreamOptions,
	StreamEvent,
	StreamResult,
} from "../src/index.ts";
import * as ai from "../src/index.ts";

type StreamOpenAIResponses = (
	model: Model,
	context: Context,
	options: OpenAIResponsesStreamOptions,
	dependencies?: OpenAIResponsesDependencies,
) => StreamResult;

const streamOpenAIResponses = Reflect.get(ai, "streamOpenAIResponses") as StreamOpenAIResponses;

const model: Model = {
	id: "test-openai-model",
	name: "Test OpenAI Model",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxOutputTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: Context = {
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
};

function sse(...events: readonly unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkedSse(payload: string, splitAt: readonly number[]): Response {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (const end of splitAt) {
		chunks.push(encoder.encode(payload.slice(offset, end)));
		offset = end;
	}
	chunks.push(encoder.encode(payload.slice(offset)));

	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function collect(stream: StreamResult): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function dependencies(response: Response): OpenAIResponsesDependencies & { fetch: ReturnType<typeof vi.fn> } {
	return {
		fetch: vi.fn(async () => response),
		now: () => 1234,
	};
}

const options: OpenAIResponsesStreamOptions = { apiKey: "test-key", temperature: 0, maxTokens: 64 };

describe("streamOpenAIResponses", () => {
	it("posts the 11a request and maps chunked text, usage, and stop", async () => {
		const payload = [
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.in_progress", response: { id: "resp_1" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hel" },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "lo" },
			{ type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
			{
				type: "response.content_part.done",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "Hello", annotations: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
						input_tokens_details: { cached_tokens: 3 },
					},
				},
			},
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		const deps = dependencies(chunkedSse(payload, [3, 19, 77, 131]));

		const stream = streamOpenAIResponses(model, context, options, deps);
		const events = await collect(stream);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(await stream.result()).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			provider: "openai",
			model: "test-openai-model",
			usage: {
				input: 7,
				output: 2,
				cacheRead: 3,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1234,
			stopReason: "stop",
		});
		expect(deps.fetch).toHaveBeenCalledOnce();
		const [url, init] = deps.fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/responses");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			accept: "text/event-stream",
			authorization: "Bearer test-key",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: "test-openai-model",
			instructions: "Answer briefly.",
			stream: true,
			store: false,
			temperature: 0,
			max_output_tokens: 64,
		});
	});

	it("maps function argument deltas and preserves the call id", async () => {
		const response = sse(
			{ type: "response.created", response: { id: "resp_tool" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_7", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"READ' },
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: 'ME.md"}' },
			{
				type: "response.function_call_arguments.done",
				output_index: 0,
				arguments: '{"path":"README.md"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_7",
					name: "read",
					arguments: '{"path":"README.md"}',
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } },
			},
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		const events = await collect(stream);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_end",
			"done",
		]);
		expect(await stream.result()).toMatchObject({
			content: [{ type: "tool_call", id: "call_7", name: "read", arguments: { path: "README.md" } }],
			stopReason: "tool_use",
		});
	});

	it("maps an incomplete response to the length stop reason", async () => {
		const response = sse({
			type: "response.incomplete",
			response: { status: "incomplete", usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 } },
		});
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({ stopReason: "length", content: [] });
	});

	it("turns an HTTP failure into a terminal protocol error without leaking the key", async () => {
		const stream = streamOpenAIResponses(
			model,
			context,
			options,
			dependencies(new Response("secret upstream body", { status: 429 })),
		);

		const events = await collect(stream);
		const result = await stream.result();

		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI request failed with HTTP 429",
		});
		expect(JSON.stringify(result)).not.toContain("test-key");
		expect(JSON.stringify(result)).not.toContain("secret upstream body");
	});

	it("turns response.failed into a terminal protocol error", async () => {
		const response = sse({
			type: "response.failed",
			response: { status: "failed", error: { code: "server_error", message: "Upstream failed" } },
		});
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "server_error: Upstream failed",
		});
	});

	it("maps the top-level error event shape used by Responses", async () => {
		const response = sse({ type: "error", code: "rate_limit_exceeded", message: "Slow down", param: null });
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "rate_limit_exceeded: Slow down",
		});
	});

	it("normalizes malformed SSE JSON", async () => {
		const response = new Response("data: {not-json}\n\n", { status: 200 });
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: event data must be valid JSON",
		});
	});

	it("preserves partial text when the stream reaches EOF before a terminal event", async () => {
		const response = sse(
			{ type: "response.created", response: { id: "resp_eof" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_eof", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "text", text: "partial" }],
			stopReason: "error",
			errorMessage: "OpenAI Responses stream ended before a terminal response event",
		});
	});

	it("aborts a pending stream read and ends with aborted", async () => {
		const abortController = new AbortController();
		const encoder = new TextEncoder();
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_abort" } })}\n\n`,
							),
						);
						const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
						signal?.addEventListener("abort", abort, { once: true });
					},
				}),
				{ status: 200 },
			);
		});
		const stream = streamOpenAIResponses(
			model,
			context,
			{ ...options, signal: abortController.signal },
			{ fetch, now: () => 1234 },
		);
		const eventsPromise = collect(stream);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

		abortController.abort(new Error("private abort reason"));
		await eventsPromise;

		expect(await stream.result()).toMatchObject({
			stopReason: "aborted",
			errorMessage: "OpenAI request aborted",
		});
	});

	it("rejects interleaved output items instead of violating the unified stream", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "read", arguments: "" },
			},
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: output items must not be interleaved",
		});
	});
});
