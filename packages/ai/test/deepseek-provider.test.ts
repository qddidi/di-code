import { describe, expect, it, vi } from "vitest";
import type { Context, DeepSeekProviderOptions, Model, StreamEvent, StreamResult } from "../src/index.ts";
import { createDeepSeekProvider } from "../src/index.ts";
import { MODELS } from "../src/models.generated.ts";

const model: Model = {
	id: "test-deepseek-model",
	name: "Test DeepSeek Model",
	provider: "deepseek",
	api: "openai-chat-completions",
	baseUrl: "https://model.deepseek.example",
	input: ["text"],
	reasoning: true,
	chatCompletionsCompat: {
		thinkingFormat: "deepseek",
		maxTokensField: "max_tokens",
		supportsUsageInStreaming: true,
		supportsReasoningEffort: true,
	},
	contextWindow: 1_000_000,
	maxOutputTokens: 384_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: Context = {
	messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
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

function completedResponse(text = "ok"): Response {
	return sse(
		{ choices: [{ delta: { reasoning_content: "plan" }, finish_reason: null }] },
		{ choices: [{ delta: { content: text }, finish_reason: null }] },
		{
			choices: [{ delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
		},
	);
}

function baseOptions(overrides: Partial<DeepSeekProviderOptions> = {}): DeepSeekProviderOptions {
	return { models: [model], env: {}, apiKey: "test-deepseek-key", ...overrides };
}

describe("createDeepSeekProvider", () => {
	it("uses generated DeepSeek models through Chat Completions", () => {
		const provider = createDeepSeekProvider({ apiKey: "test-deepseek-key", env: {} });
		expect(provider).toMatchObject({ id: "deepseek", name: "DeepSeek" });
		expect(provider.models).toEqual(
			MODELS.filter((entry) => entry.provider === "deepseek" && entry.api === "openai-chat-completions"),
		);
	});

	it("streams reasoning, text, usage, and DeepSeek request fields", async () => {
		const fetch = vi.fn(async () => completedResponse("deepseek works"));
		const provider = createDeepSeekProvider(baseOptions({ fetch, now: () => 1234 }));
		const result = await provider.stream(model, context, { maxTokens: 128, reasoningEffort: "high" }).result();

		expect(result).toMatchObject({
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "deepseek works" },
			],
			provider: "deepseek",
			model: "test-deepseek-model",
			usage: { input: 7, output: 2, totalTokens: 9 },
			timestamp: 1234,
			stopReason: "stop",
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://model.deepseek.example/chat/completions");
		expect(init.headers).toMatchObject({ authorization: "Bearer test-deepseek-key" });
		expect(JSON.parse(String(init.body))).toMatchObject({
			max_tokens: 128,
			thinking: { type: "enabled" },
			reasoning_effort: "high",
		});
	});

	it("rejects image input before making a request for text-only models", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createDeepSeekProvider(baseOptions({ fetch }));
		const stream = provider.stream(model, {
			messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }],
		});
		await collect(stream);
		expect(fetch).not.toHaveBeenCalled();
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "DeepSeek request failed: model test-deepseek-model does not support image input",
		});
	});

	it("resolves credentials and endpoint priority", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createDeepSeekProvider(
			baseOptions({
				apiKey: " explicit-key ",
				baseUrl: " https://explicit.deepseek.example/v1/ ",
				env: { DEEPSEEK_API_KEY: "env-key", DEEPSEEK_BASE_URL: "https://env.deepseek.example/v1" },
				fetch,
			}),
		);
		await collect(provider.stream(model, context));
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://explicit.deepseek.example/v1/chat/completions");
		expect(init.headers).toMatchObject({ authorization: "Bearer explicit-key" });
	});

	it("retries transient responses and does not leak the API key", async () => {
		const fetch = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "test-deepseek-key is invalid" } }), {
					status: 401,
				}),
			);
		const sleeps: number[] = [];
		const provider = createDeepSeekProvider(
			baseOptions({
				fetch,
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds);
				},
			}),
		);
		const stream = provider.stream(model, context);
		await collect(stream);
		const result = await stream.result();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([250]);
		expect(result.errorMessage).toContain("invalid_api_key");
		expect(JSON.stringify(result)).not.toContain("test-deepseek-key");
	});
});
