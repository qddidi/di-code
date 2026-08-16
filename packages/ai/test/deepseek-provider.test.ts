import { describe, expect, it, vi } from "vitest";
import type { Context, DeepSeekProviderOptions, Model, StreamEvent, StreamResult } from "../src/index.ts";
import { createDeepSeekProvider } from "../src/index.ts";
import { MODELS } from "../src/models.generated.ts";

const model: Model = {
	id: "test-deepseek-model",
	name: "Test DeepSeek Model",
	provider: "deepseek",
	api: "deepseek-responses",
	baseUrl: "https://model.deepseek.example",
	input: ["text"],
	reasoning: true,
	contextWindow: 1_000_000,
	maxOutputTokens: 384_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: Context = {
	messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
};

function responseEvents(...events: readonly unknown[]): Response {
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

function completedResponse(text = "ok"): Response {
	return responseEvents(
		{ type: "response.created", response: { id: "resp_deepseek_provider" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_deepseek_provider", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", output_index: 0, content_index: 0, text },
		{ type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text } },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_deepseek_provider",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } },
			},
		},
	);
}

function baseOptions(overrides: Partial<DeepSeekProviderOptions> = {}): DeepSeekProviderOptions {
	return { models: [model], env: {}, ...overrides };
}

describe("createDeepSeekProvider", () => {
	it("uses generated DeepSeek models when models are omitted", () => {
		const provider = createDeepSeekProvider({ apiKey: "test-deepseek-key", env: {} });

		expect(provider).toMatchObject({ id: "deepseek", name: "DeepSeek" });
		expect(provider.models).toEqual(
			MODELS.filter((entry) => entry.provider === "deepseek" && entry.api === "deepseek-responses"),
		);
	});

	it("streams text and cached usage through the DeepSeek Responses adapter", async () => {
		const fetch = vi.fn(async () => completedResponse("deepseek works"));
		const provider = createDeepSeekProvider(baseOptions({ apiKey: " test-deepseek-key ", fetch, now: () => 1234 }));
		const stream = provider.stream(model, context, { maxTokens: 128 });

		await expect(stream.result()).resolves.toMatchObject({
			content: [{ type: "text", text: "deepseek works" }],
			provider: "deepseek",
			model: "test-deepseek-model",
			usage: { input: 4, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 9 },
			timestamp: 1234,
			stopReason: "stop",
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://model.deepseek.example/responses");
		expect(init.headers).toMatchObject({ authorization: "Bearer test-deepseek-key" });
		expect(JSON.parse(String(init.body))).not.toHaveProperty("prompt_cache_key");
		expect(JSON.parse(String(init.body))).not.toHaveProperty("include");
	});

	it("rejects image input before making a request for text-only DeepSeek models", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createDeepSeekProvider(baseOptions({ apiKey: "test-deepseek-key", fetch }));
		const stream = provider.stream(model, {
			messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }],
		});

		await collect(stream);

		expect(fetch).not.toHaveBeenCalled();
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI request failed",
		});
	});

	it("prefers explicit key over DEEPSEEK_API_KEY and falls back from blank explicit key", async () => {
		const explicitFetch = vi.fn(async () => completedResponse());
		const explicitProvider = createDeepSeekProvider(
			baseOptions({ apiKey: " explicit-key ", env: { DEEPSEEK_API_KEY: "env-key" }, fetch: explicitFetch }),
		);
		await collect(explicitProvider.stream(model, context));
		expect((explicitFetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
			authorization: "Bearer explicit-key",
		});

		const fallbackFetch = vi.fn(async () => completedResponse());
		const fallbackProvider = createDeepSeekProvider(
			baseOptions({ apiKey: "  ", env: { DEEPSEEK_API_KEY: " env-key " }, fetch: fallbackFetch }),
		);
		await collect(fallbackProvider.stream(model, context));
		expect((fallbackFetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
			authorization: "Bearer env-key",
		});
	});

	it("requires credentials before making a request", () => {
		const fetch = vi.fn(async () => completedResponse());

		expect(() => createDeepSeekProvider(baseOptions({ fetch }))).toThrow("DeepSeek API key is required");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("resolves base URL with explicit, env, model, then default priority", async () => {
		const explicitFetch = vi.fn(async () => completedResponse());
		const explicitProvider = createDeepSeekProvider(
			baseOptions({
				apiKey: "test-deepseek-key",
				baseUrl: " https://explicit.deepseek.example/v1/ ",
				env: { DEEPSEEK_BASE_URL: "https://env.deepseek.example/v1" },
				fetch: explicitFetch,
			}),
		);
		await collect(explicitProvider.stream(model, context));
		expect((explicitFetch.mock.calls[0] as unknown as [string])[0]).toBe(
			"https://explicit.deepseek.example/v1/responses",
		);

		const envFetch = vi.fn(async () => completedResponse());
		const envProvider = createDeepSeekProvider(
			baseOptions({
				apiKey: "test-deepseek-key",
				env: { DEEPSEEK_BASE_URL: "https://env.deepseek.example/v1/" },
				fetch: envFetch,
			}),
		);
		await collect(envProvider.stream(model, context));
		expect((envFetch.mock.calls[0] as unknown as [string])[0]).toBe("https://env.deepseek.example/v1/responses");

		const modelFetch = vi.fn(async () => completedResponse());
		const modelProvider = createDeepSeekProvider(
			baseOptions({ apiKey: "test-deepseek-key", env: {}, fetch: modelFetch }),
		);
		await collect(modelProvider.stream(model, context));
		expect((modelFetch.mock.calls[0] as unknown as [string])[0]).toBe("https://model.deepseek.example/responses");

		const defaultFetch = vi.fn(async () => completedResponse());
		const defaultProvider = createDeepSeekProvider(
			baseOptions({
				apiKey: "test-deepseek-key",
				env: {},
				fetch: defaultFetch,
				models: [{ ...model, baseUrl: undefined }],
			}),
		);
		await collect(defaultProvider.stream({ ...model, baseUrl: undefined }, context));
		expect((defaultFetch.mock.calls[0] as unknown as [string])[0]).toBe("https://api.deepseek.com/responses");
	});

	it("rejects invalid base URLs and mismatched model ownership before making a request", () => {
		const fetch = vi.fn(async () => completedResponse());

		expect(() =>
			createDeepSeekProvider(baseOptions({ apiKey: "test-deepseek-key", baseUrl: "file:///tmp/deepseek", fetch })),
		).toThrow("DeepSeek baseUrl must use http or https");
		expect(() =>
			createDeepSeekProvider(baseOptions({ apiKey: "test-deepseek-key", baseUrl: "https://user:secret@example.com" })),
		).toThrow("DeepSeek baseUrl must not contain credentials, query, or hash");
		expect(() =>
			createDeepSeekProvider({
				models: [{ ...model, provider: "openai" }],
				apiKey: "test-deepseek-key",
				env: {},
				fetch,
			}),
		).toThrow('DeepSeek Responses provider models must use provider "deepseek" and api "deepseek-responses"');
		expect(fetch).not.toHaveBeenCalled();
	});

	it("retries only 429, 500, and 503 with bounded backoff", async () => {
		for (const status of [429, 500, 503]) {
			const fetch = vi
				.fn<() => Promise<Response>>()
				.mockResolvedValueOnce(new Response("busy", { status }))
				.mockResolvedValueOnce(completedResponse(`retry ${status}`));
			const sleeps: number[] = [];
			const provider = createDeepSeekProvider(
				baseOptions({
					apiKey: "test-deepseek-key",
					fetch,
					sleep: async (milliseconds) => {
						sleeps.push(milliseconds);
					},
				}),
			);

			await expect(provider.stream(model, context).result()).resolves.toMatchObject({
				content: [{ type: "text", text: `retry ${status}` }],
			});
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(sleeps).toEqual([250]);
		}
	});

	it("does not retry non-transient DeepSeek status codes", async () => {
		for (const status of [400, 401, 402, 422]) {
			const fetch = vi.fn(
				async () => new Response(JSON.stringify({ error: { message: "private", code: "bad" } }), { status }),
			);
			const provider = createDeepSeekProvider(baseOptions({ apiKey: "test-deepseek-key", fetch }));

			await collect(provider.stream(model, context));

			expect(fetch).toHaveBeenCalledOnce();
		}
	});

	it("does not leak keys or raw response bodies in normalized errors", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "test-deepseek-key is invalid and should never appear",
							code: "invalid_api_key",
							type: "authentication_error",
						},
					}),
					{ status: 401, headers: { "x-request-id": "req_deepseek" } },
				),
		);
		const provider = createDeepSeekProvider(baseOptions({ apiKey: "test-deepseek-key", fetch }));
		const stream = provider.stream(model, context);

		await collect(stream);
		const result = await stream.result();

		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "DeepSeek request failed with HTTP 401",
		});
		expect(JSON.stringify(result)).not.toContain("test-deepseek-key");
		expect(JSON.stringify(result)).not.toContain("should never appear");
	});

	it("stops after three transient attempts", async () => {
		const fetch = vi.fn(async () => new Response("server down", { status: 503 }));
		const sleeps: number[] = [];
		const provider = createDeepSeekProvider(
			baseOptions({
				apiKey: "test-deepseek-key",
				fetch,
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds);
				},
			}),
		);

		await collect(provider.stream(model, context));

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 500]);
	});

	it("stops retrying when abort occurs during backoff", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => new Response("busy", { status: 429 }));
		const sleep = vi.fn((_milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));
		const provider = createDeepSeekProvider(baseOptions({ apiKey: "test-deepseek-key", fetch, sleep }));
		const stream = provider.stream(model, context, { signal: controller.signal });
		await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
		controller.abort();

		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "aborted",
			errorMessage: "OpenAI request aborted",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
