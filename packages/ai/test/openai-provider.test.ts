import { describe, expect, it, vi } from "vitest";
import type { Context, Model, OpenAIProviderOptions, Provider, StreamEvent, StreamResult } from "../src/index.ts";
import * as ai from "../src/index.ts";
import { OpenAIProviderError } from "../src/index.ts";
import { MODELS } from "../src/models.generated.ts";

type CreateOpenAIProvider = (options: OpenAIProviderOptions) => Provider;
const createOpenAIProvider = Reflect.get(ai, "createOpenAIProvider") as CreateOpenAIProvider;

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
const context: Context = { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }] };

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

function baseOptions(overrides: Partial<OpenAIProviderOptions> = {}): OpenAIProviderOptions {
	return { models: [model], env: {}, ...overrides };
}

function completedResponse(text = "ok"): Response {
	return responseEvents(
		{ type: "response.created", response: { id: "resp_provider" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_provider", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", output_index: 0, content_index: 0, text },
		{ type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text } },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_provider",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
	);
}

describe("createOpenAIProvider", () => {
	it("uses generated OpenAI models when models are omitted", () => {
		const provider = createOpenAIProvider({ apiKey: "key", env: {} });

		expect(provider.models).toEqual(
			MODELS.filter((entry) => entry.provider === "openai" && entry.api === "openai-responses"),
		);
	});

	it("uses model.baseUrl when no process-level override exists", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const requestModel = { ...model, baseUrl: "https://model.example/v1" };
		const provider = createOpenAIProvider({ models: [requestModel], apiKey: "key", env: {}, fetch });

		await collect(provider.stream(requestModel, context));

		expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://model.example/v1/responses");
	});

	it("prefers OPENAI_BASE_URL over model.baseUrl", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const requestModel = { ...model, baseUrl: "https://model.example/v1" };
		const provider = createOpenAIProvider({
			models: [requestModel],
			apiKey: "key",
			env: { OPENAI_BASE_URL: "https://env.example/v1" },
			fetch,
		});

		await collect(provider.stream(requestModel, context));

		expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://env.example/v1/responses");
	});

	it("prefers an explicit baseUrl over env and model.baseUrl", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const requestModel = { ...model, baseUrl: "https://model.example/v1" };
		const provider = createOpenAIProvider({
			models: [requestModel],
			apiKey: "key",
			env: { OPENAI_BASE_URL: "https://env.example/v1" },
			baseUrl: " https://explicit.example/v1/ ",
			fetch,
		});

		await collect(provider.stream(requestModel, context));

		expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://explicit.example/v1/responses");
	});

	it("ignores a blank OPENAI_BASE_URL and uses model.baseUrl", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const requestModel = { ...model, baseUrl: "https://model.example/v1" };
		const provider = createOpenAIProvider({
			models: [requestModel],
			apiKey: "key",
			env: { OPENAI_BASE_URL: "  " },
			fetch,
		});

		await collect(provider.stream(requestModel, context));

		expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://model.example/v1/responses");
	});

	it("rejects an invalid model baseUrl before making a request", () => {
		const fetch = vi.fn(async () => completedResponse());
		const requestModel = { ...model, baseUrl: "file:///tmp/openai" };

		expect(() => createOpenAIProvider({ models: [requestModel], apiKey: "key", env: {}, fetch })).toThrow(
			"OpenAI baseUrl must use http or https",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns an OpenAI provider with copied models and streams through the adapter", async () => {
		const fetch = vi.fn(async () => completedResponse("provider works"));
		const provider = createOpenAIProvider({
			...baseOptions({ apiKey: " explicit-key ", fetch }),
			sleep: async () => {},
		});

		expect(provider.id).toBe("openai");
		expect(provider.name).toBe("OpenAI");
		expect(provider.models).toEqual([model]);
		expect(provider.models).not.toBe(baseOptions().models as readonly Model[]);
		await expect(provider.stream(model, context).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "provider works" }],
			stopReason: "stop",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("prefers a nonblank explicit key over env", () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createOpenAIProvider(baseOptions({ apiKey: " explicit ", env: { OPENAI_API_KEY: "env" }, fetch }));
		const stream = provider.stream(model, context);
		return collect(stream).then(() => {
			const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(init.headers).toMatchObject({ authorization: "Bearer explicit" });
		});
	});

	it("falls back from a blank explicit key to env", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createOpenAIProvider(baseOptions({ apiKey: "  ", env: { OPENAI_API_KEY: " env-key " }, fetch }));
		await collect(provider.stream(model, context));
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({ authorization: "Bearer env-key" });
	});

	it("prefers an explicit base URL and removes its trailing slash", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createOpenAIProvider({
			...baseOptions({ apiKey: "key", env: { OPENAI_BASE_URL: "https://env.example/v1" }, fetch }),
			baseUrl: " https://proxy.example/openai/v1/ ",
		} as OpenAIProviderOptions);

		await collect(provider.stream(model, context));

		const firstCall = fetch.mock.calls[0] as unknown as [string];
		expect(firstCall[0]).toBe("https://proxy.example/openai/v1/responses");
	});

	it("falls back from a blank explicit base URL to env", async () => {
		const fetch = vi.fn(async () => completedResponse());
		const provider = createOpenAIProvider({
			...baseOptions({ apiKey: "key", env: { OPENAI_BASE_URL: "http://127.0.0.1:8080/v1/" }, fetch }),
			baseUrl: "  ",
		} as OpenAIProviderOptions);

		await collect(provider.stream(model, context));

		const firstCall = fetch.mock.calls[0] as unknown as [string];
		expect(firstCall[0]).toBe("http://127.0.0.1:8080/v1/responses");
	});

	it("rejects an invalid base URL before making a request", () => {
		const fetch = vi.fn(async () => completedResponse());

		expect(() =>
			createOpenAIProvider({
				...baseOptions({ apiKey: "key", fetch }),
				baseUrl: "file:///tmp/openai",
			} as OpenAIProviderOptions),
		).toThrow("OpenAI baseUrl must use http or https");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects missing credentials before making a request", () => {
		try {
			createOpenAIProvider(baseOptions());
			throw new Error("expected createOpenAIProvider to throw");
		} catch (cause) {
			expect(cause).toBeInstanceOf(OpenAIProviderError);
			expect(cause).toMatchObject({
				message: "OpenAI API key is required",
				kind: "authentication",
				retryable: false,
			});
		}
	});

	it("retries 429 once with a deterministic 250ms backoff", async () => {
		const fetch = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(new Response("busy", { status: 429 }))
			.mockResolvedValueOnce(completedResponse("retry success"));
		const sleeps: number[] = [];
		const provider = createOpenAIProvider(
			baseOptions({
				apiKey: "key",
				fetch,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);

		await expect(provider.stream(model, context).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "retry success" }],
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([250]);
	});

	it("retries connection failures with 250ms then 500ms backoff", async () => {
		const fetch = vi
			.fn<() => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError("socket closed"))
			.mockRejectedValueOnce(new TypeError("socket closed"))
			.mockResolvedValueOnce(completedResponse("third attempt"));
		const sleeps: number[] = [];
		const provider = createOpenAIProvider(
			baseOptions({
				apiKey: "key",
				fetch,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);

		await expect(provider.stream(model, context).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "third attempt" }],
		});
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 500]);
	});

	it("does not retry 401 and exposes only normalized error fields", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: { message: "bad key", code: "invalid_api_key", type: "authentication_error" } }),
					{
						status: 401,
						headers: { "x-request-id": "req_123" },
					},
				),
		);
		const provider = createOpenAIProvider(baseOptions({ apiKey: "key", fetch }));
		const stream = provider.stream(model, context);

		await collect(stream);
		const result = await stream.result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "OpenAI request failed with HTTP 401" });
	});

	it("stops after three 5xx attempts", async () => {
		const fetch = vi.fn(async () => new Response("server down", { status: 503 }));
		const sleeps: number[] = [];
		const provider = createOpenAIProvider(
			baseOptions({
				apiKey: "key",
				fetch,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);

		await collect(provider.stream(model, context));
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 500]);
	});

	it("stops retrying immediately when abort occurs during backoff", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => new Response("busy", { status: 429 }));
		const sleep = vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));
		const provider = createOpenAIProvider(baseOptions({ apiKey: "key", fetch, sleep }));
		const stream = provider.stream(model, context, { signal: controller.signal });
		await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
		controller.abort();

		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "aborted",
			errorMessage: "OpenAI request aborted",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("does not retry an EOF after the response stream has started", async () => {
		const fetch = vi.fn(async () =>
			completedResponse("unterminated").body
				? new Response(
						'data: {"type":"response.created"}\n\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m","role":"assistant","status":"in_progress","content":[]}}\n\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"half"}\n',
						{ status: 200 },
					)
				: completedResponse(),
		);
		const provider = createOpenAIProvider(baseOptions({ apiKey: "key", fetch }));

		await expect(provider.stream(model, context).result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI Responses stream ended before a terminal response event",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
