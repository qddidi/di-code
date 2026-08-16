import { streamOpenAIChatCompletions } from "../api/openai-chat-completions.ts";
import { MODELS } from "../models.generated.ts";
import type { Model, Provider } from "../types.ts";
import type { ResponsesProviderOptions } from "./responses.ts";

export interface ZhipuProviderOptions extends ResponsesProviderOptions {
	readonly models?: readonly Model[];
}

const RETRY_DELAYS = [250, 500] as const;

function resolveKey(options: ZhipuProviderOptions): string {
	const key = options.apiKey?.trim() || (options.env ?? process.env).ZAI_API_KEY?.trim();
	if (!key) throw new Error("Zhipu AI API key is required");
	return key;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Zhipu baseUrl must use http or https");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Zhipu baseUrl must not contain credentials, query, or hash");
	return value.trim().replace(/\/+$/, "");
}

function wait(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
	return Promise.race([
		sleep(ms),
		new Promise<never>((_, reject) =>
			signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
		),
	]);
}

export function createZhipuProvider(options: ZhipuProviderOptions = {}): Provider {
	const configured = options.models;
	const catalog =
		configured ?? MODELS.filter((model) => model.provider === "zhipu" && model.api === "zhipu-chat-completions");
	if (catalog.length === 0) throw new Error("Zhipu AI provider requires at least one model");
	for (const model of catalog) {
		if (model.provider !== "zhipu" || model.api !== "zhipu-chat-completions")
			throw new Error('Zhipu models must use provider "zhipu" and api "zhipu-chat-completions"');
	}
	const apiKey = resolveKey(options);
	const configuredBaseUrl = options.baseUrl?.trim() || (options.env ?? process.env).ZHIPU_BASE_URL?.trim();
	const baseUrl = configuredBaseUrl === undefined ? undefined : normalizeBaseUrl(configuredBaseUrl);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const retryFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				response = await fetchImpl(input, init);
			} catch (cause) {
				if (
					init?.signal?.aborted ||
					(cause instanceof DOMException && cause.name === "AbortError") ||
					attempt >= RETRY_DELAYS.length
				)
					throw cause;
				await wait(sleep, RETRY_DELAYS[attempt], init?.signal ?? undefined);
				continue;
			}
			if (response.ok) return response;
			if (![429, 500, 503].includes(response.status) || attempt >= RETRY_DELAYS.length) return response;
			await response.body?.cancel();
			await wait(sleep, RETRY_DELAYS[attempt], init?.signal ?? undefined);
		}
	};
	return {
		id: "zhipu",
		name: "Zhipu AI",
		models: catalog.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } })),
		stream(model, context, streamOptions) {
			return streamOpenAIChatCompletions(
				model,
				context,
				{ ...streamOptions, apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) },
				{ fetch: retryFetch, now: options.now },
			);
		},
	};
}
