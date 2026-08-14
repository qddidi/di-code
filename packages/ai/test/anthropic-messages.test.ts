import { describe, expect, it, vi } from "vitest";
import {
	buildAnthropicMessagesRequest,
	type Context,
	createAnthropicProvider,
	type Model,
	type StreamEvent,
	streamAnthropicMessages,
} from "../src/index.ts";

const model: Model = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	provider: "anthropic",
	api: "anthropic-messages",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 200000,
	maxOutputTokens: 64000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const context: Context = {
	systemPrompt: "Be concise.",
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "Hello" },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
			timestamp: 1,
		},
	],
};

function sse(...events: readonly unknown[]): Response {
	return new Response(
		events
			.map(
				(event) =>
					`event: ${String((event as { type?: unknown }).type ?? "message")}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}
async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Anthropic Messages", () => {
	it("projects text, image, tools, thinking and streaming options", () => {
		const request = buildAnthropicMessagesRequest(
			model,
			{
				...context,
				tools: [{ name: "read", description: "Read file", parameters: { type: "object", properties: {} } as never }],
			},
			{ maxTokens: 4000, temperature: 0.2 },
		);
		expect(request).toMatchObject({
			model: model.id,
			max_tokens: 4000,
			system: "Be concise.",
			stream: true,
			temperature: 0.2,
			thinking: { type: "enabled" },
		});
		expect(request.messages[0]?.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
		]);
		expect(request.tools?.[0]).toMatchObject({ name: "read", input_schema: { type: "object" } });
	});

	it("maps text, thinking and tool-use SSE events", async () => {
		const response = sse(
			{ type: "message_start", message: { usage: { input_tokens: 7 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
			{ type: "content_block_stop", index: 1 },
			{
				type: "content_block_start",
				index: 2,
				content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} },
			},
			{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
			{ type: "content_block_stop", index: 2 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
			{ type: "message_stop" },
		);
		const fetch = vi.fn(async () => response);
		const stream = streamAnthropicMessages(model, context, { apiKey: "secret" }, { fetch, now: () => 42 });
		expect((await collect(stream)).map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_end",
			"done",
		]);
		expect(await stream.result()).toMatchObject({
			provider: "anthropic",
			stopReason: "tool_use",
			usage: { input: 7, output: 9, totalTokens: 16 },
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "answer" },
				{ type: "tool_call", id: "tool_1", arguments: { path: "a.txt" } },
			],
		});
	});

	it("normalizes HTTP failures and never includes the key", async () => {
		const stream = streamAnthropicMessages(
			model,
			context,
			{ apiKey: "secret" },
			{ fetch: vi.fn(async () => new Response("upstream secret", { status: 401 })) },
		);
		await collect(stream);
		const result = await stream.result();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Anthropic request failed with HTTP 401" });
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("uses explicit credentials before environment credentials", async () => {
		const fetch = vi.fn(async () =>
			sse(
				{ type: "message_start", message: { usage: { input_tokens: 1 } } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			),
		);
		const provider = createAnthropicProvider({
			models: [model],
			apiKey: "explicit",
			env: { ANTHROPIC_API_KEY: "env" },
			fetch,
		});
		await provider
			.stream(model, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] })
			.result();
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({ "x-api-key": "explicit", "anthropic-version": "2023-06-01" });
	});

	it("ends a pending read as aborted", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							init?.signal?.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), {
								once: true,
							});
						},
					}),
					{ status: 200 },
				),
		);
		const result = streamAnthropicMessages(
			model,
			context,
			{ apiKey: "secret", signal: controller.signal },
			{ fetch },
		).result();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		controller.abort();
		expect(await result).toMatchObject({ stopReason: "aborted", errorMessage: "Anthropic request aborted" });
	});
});
