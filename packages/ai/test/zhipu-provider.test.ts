import { describe, expect, it, vi } from "vitest";
import type { Context, Model, StreamEvent, StreamResult, ZhipuProviderOptions } from "../src/index.ts";
import { createZhipuProvider } from "../src/index.ts";

const model: Model = {
	id: "glm-4.7",
	name: "GLM-4.7",
	provider: "zhipu",
	api: "openai-chat-completions",
	baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
	input: ["text"],
	reasoning: true,
	chatCompletionsCompat: {
		maxTokensField: "max_tokens",
		supportsUsageInStreaming: true,
		thinkingFormat: "zai",
		zaiToolStream: true,
	},
	contextWindow: 200_000,
	maxOutputTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: Context = {
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	],
};

function sse(...chunks: readonly unknown[]): Response {
	return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function collect(stream: StreamResult): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function options(overrides: Partial<ZhipuProviderOptions> = {}): ZhipuProviderOptions {
	return { models: [model], apiKey: "test-zhipu-key", env: {}, now: () => 1234, ...overrides };
}

describe("createZhipuProvider", () => {
	it("maps GLM reasoning, text, usage, and tool definitions from Chat Completions", async () => {
		const fetch = vi.fn(async () =>
			sse(
				{ choices: [{ delta: { reasoning_content: "Plan" }, finish_reason: null }] },
				{ choices: [{ delta: { reasoning_content: " first" }, finish_reason: null }] },
				{ choices: [{ delta: { content: "Done" }, finish_reason: null }] },
				{
					choices: [{ delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
				},
			),
		);
		const provider = createZhipuProvider(options({ fetch }));
		const stream = provider.stream(model, context, { maxTokens: 64, temperature: 0.8 });

		expect((await collect(stream)).map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(await stream.result()).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Plan first" },
				{ type: "text", text: "Done" },
			],
			provider: "zhipu",
			model: "glm-4.7",
			usage: {
				input: 7,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1234,
			stopReason: "stop",
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
		expect(init.headers).toEqual({
			accept: "text/event-stream",
			authorization: "Bearer test-zhipu-key",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: "glm-4.7",
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 64,
			temperature: 0.8,
			messages: [
				{ role: "system", content: "Answer briefly." },
				{ role: "user", content: "Hello" },
			],
			tools: [{ type: "function", function: { name: "read", description: "Read a file" } }],
		});
	});

	it("buffers tool call deltas into a valid unified tool event sequence", async () => {
		const provider = createZhipuProvider(
			options({
				fetch: vi.fn(async () =>
					sse(
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_read",
												type: "function",
												function: { name: "read", arguments: '{"path":"REA' },
											},
										],
									},
									finish_reason: null,
								},
							],
						},
						{
							choices: [
								{
									delta: { tool_calls: [{ index: 0, function: { arguments: 'DME.md"}' } }] },
									finish_reason: "tool_calls",
								},
							],
							usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
						},
					),
				),
			}),
		);
		const stream = provider.stream(model, context);

		expect((await collect(stream)).map((event) => event.type)).toEqual([
			"start",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_end",
			"done",
		]);
		expect(await stream.result()).toMatchObject({
			content: [{ type: "tool_call", id: "call_read", name: "read", arguments: { path: "README.md" } }],
			stopReason: "tool_use",
		});
	});

	it("uses ZAI_API_KEY and rejects unsupported image input before fetching", async () => {
		const fetch = vi.fn(async () => sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
		const provider = createZhipuProvider(options({ apiKey: " ", env: { ZAI_API_KEY: " env-key " }, fetch }));
		const stream = provider.stream(model, {
			messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }],
		});

		await collect(stream);
		expect(fetch).not.toHaveBeenCalled();
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Zhipu AI request failed: model glm-4.7 does not support image input",
		});
	});
});
