import { describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../src/index.ts";
import { createOpenAIChatCompletionsProvider } from "../src/index.ts";

const model: Model = {
	id: "glm-5.3",
	name: "GLM-5.3",
	provider: "custom-chat",
	api: "openai-chat-completions",
	baseUrl: "https://chat.example.test/v1",
	input: ["text"],
	reasoning: true,
	reasoningEfforts: ["low", "medium", "high"],
	chatCompletionsCompat: {
		thinkingFormat: "zai",
		supportsReasoningEffort: true,
		zaiToolStream: true,
	},
	contextWindow: 200_000,
	maxOutputTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: Context = {
	messages: [{ role: "user", content: [{ type: "text", text: "Call read" }], timestamp: 1 }],
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

describe("OpenAI Chat Completions compatibility", () => {
	it("uses the protocol for a non-Zhipu provider and projects GLM compatibility fields", async () => {
		const fetch = vi.fn(async () =>
			sse(
				{ choices: [{ delta: { reasoning_content: "plan" }, finish_reason: null }] },
				{
					choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				},
			),
		);
		const provider = createOpenAIChatCompletionsProvider({
			providerId: "custom-chat",
			name: "Custom Chat",
			apiKey: "test-key",
			models: [model],
			fetch,
		});

		const result = await provider.stream(model, context, { reasoningEffort: "medium" }).result();
		expect(result).toMatchObject({
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "done" },
			],
			stopReason: "stop",
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://chat.example.test/v1/chat/completions");
		expect(JSON.parse(String(init.body))).toMatchObject({
			thinking: { type: "enabled", clear_thinking: false },
			reasoning_effort: "medium",
			tool_stream: true,
		});
	});

	it("keeps interleaved tool call arguments separate by stream index", async () => {
		const fetch = vi.fn(async () =>
			sse(
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call_a", function: { name: "read", arguments: '{"path":"A' } },
									{ index: 1, id: "call_b", function: { name: "read", arguments: '{"path":"B' } },
								],
							},
							finish_reason: null,
						},
					],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, function: { arguments: '"}' } },
									{ index: 1, function: { arguments: '"}' } },
								],
							},
							finish_reason: "tool_calls",
						},
					],
				},
			),
		);
		const provider = createOpenAIChatCompletionsProvider({
			providerId: "custom-chat",
			apiKey: "test-key",
			models: [model],
			fetch,
		});

		const result = await provider.stream(model, context).result();
		expect(result.stopReason).toBe("tool_use");
		expect(result.content).toEqual([
			{ type: "tool_call", id: "call_a", name: "read", arguments: { path: "A" } },
			{ type: "tool_call", id: "call_b", name: "read", arguments: { path: "B" } },
		]);
	});

	it("reads choice usage and rejects non-success finish reasons", async () => {
		const fetch = vi.fn(async () =>
			sse({
				choices: [
					{
						delta: { reasoning_text: "hidden" },
						usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
						finish_reason: "content_filter",
					},
				],
			}),
		);
		const provider = createOpenAIChatCompletionsProvider({
			providerId: "custom-chat",
			apiKey: "test-key",
			models: [model],
			fetch,
		});
		const result = await provider.stream(model, context).result();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("content_filter") });
		expect(result.usage).toMatchObject({ input: 4, output: 1, totalTokens: 5 });
	});

	it("surfaces a safe provider error body", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "invalid_model", message: "model is unavailable" } }), {
					status: 400,
				}),
		);
		const provider = createOpenAIChatCompletionsProvider({
			providerId: "custom-chat",
			name: "Custom Chat",
			apiKey: "secret-key",
			models: [model],
			fetch,
		});

		const result = await provider.stream(model, context).result();
		expect(result).toMatchObject({ stopReason: "error" });
		expect(result.errorMessage).toContain("Custom Chat");
		expect(result.errorMessage).toContain("400");
		expect(result.errorMessage).toContain("invalid_model");
		expect(result.errorMessage).toContain("model is unavailable");
		expect(result.errorMessage).not.toContain("secret-key");
	});
});
