import { describe, expect, it, vi } from "vitest";
import type { AnthropicProviderOptions, Context, Model, StreamEvent, StreamResult } from "../src/index.ts";
import { createAnthropicProvider } from "../src/index.ts";

const model: Model = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 200_000,
	maxOutputTokens: 64_000,
	cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
};

const context: Context = {
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: [{ type: "text", text: "Read README.md" }], timestamp: 1 }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	],
};

function sse(events: readonly unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function collect(stream: StreamResult): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function options(overrides: Partial<AnthropicProviderOptions> = {}): AnthropicProviderOptions {
	return { models: [model], apiKey: "test-anthropic-key", env: {}, now: () => 1234, ...overrides };
}

describe("createAnthropicProvider", () => {
	it("maps Messages API text, tool use, usage, and request fields to the common contract", async () => {
		const fetch = vi.fn(async () =>
			sse([
				{
					type: "message_start",
					message: { usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I will " } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "read it." } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
				},
				{
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
				},
				{ type: "content_block_stop", index: 1 },
				{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
				{ type: "message_stop" },
			]),
		);
		const provider = createAnthropicProvider(options({ fetch }));
		const stream = provider.stream(model, context, { maxTokens: 100, temperature: 0.4 });

		expect((await collect(stream)).map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_end",
			"done",
		]);
		const result = await stream.result();
		expect(result).toMatchObject({
			content: [
				{ type: "text", text: "I will read it." },
				{ type: "tool_call", id: "toolu_1", name: "read", arguments: { path: "README.md" } },
			],
			stopReason: "tool_use",
			usage: {
				input: 7,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				totalTokens: 15,
			},
		});
		expect(result.usage.cost).toMatchObject({ cacheRead: 0.0000006, cacheWrite: 0.00000375, total: 0.00010035 });
		expect(result.usage.cost.input).toBeCloseTo(0.000021);
		expect(result.usage.cost.output).toBeCloseTo(0.000075);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(init.headers).toEqual({
			accept: "text/event-stream",
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"x-api-key": "test-anthropic-key",
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: "claude-sonnet-4-5",
			max_tokens: 100,
			temperature: 0.4,
			stream: true,
			system: "Answer briefly.",
			messages: [{ role: "user", content: [{ type: "text", text: "Read README.md" }] }],
			tools: [{ name: "read", description: "Read a file", input_schema: context.tools?.[0]?.parameters }],
		});
	});

	it("replays a tool result as Anthropic user content and retries transient responses", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
			.mockResolvedValueOnce(
				sse([
					{ type: "message_start", message: { usage: { input_tokens: 3 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]),
			);
		const sleep = vi.fn(async () => undefined);
		const provider = createAnthropicProvider(options({ fetch, sleep }));
		const stream = provider.stream(model, {
			messages: [
				{
					role: "assistant",
					content: [{ type: "tool_call", id: "toolu_1", name: "read", arguments: { path: "README.md" } }],
					provider: "anthropic",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 1,
					stopReason: "tool_use",
				},
				{
					role: "tool_result",
					toolCallId: "toolu_1",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: 2,
				},
			],
		});

		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "Done" }],
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(250);
		const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body)).messages).toEqual([
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: [{ type: "text", text: "contents" }],
						is_error: false,
					},
				],
			},
		]);
	});
});
