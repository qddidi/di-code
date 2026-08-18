import { streamOpenAIChatCompletions } from "../api/openai-chat-completions.ts";
import { OpenAIProviderError } from "../api/openai-responses.ts";
import { MODELS } from "../models.generated.ts";
import type { Context, Model, Provider, StreamOptions, StreamResult } from "../types.ts";

export interface OpenAIChatCompletionsProviderOptions {
	readonly models?: readonly Model[];
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly providerId?: string;
	readonly name?: string;
	readonly apiKeyEnvironmentVariable?: string;
	readonly baseUrlEnvironmentVariable?: string;
	readonly defaultBaseUrl?: string;
}

const RETRY_DELAYS = [250, 500] as const;

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function normalizeBaseUrl(value: string, label: string): string {
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`${label} baseUrl must be an absolute http or https URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} baseUrl must use http or https`);
	if (url.username || url.password || url.search || url.hash)
		throw new Error(`${label} baseUrl must not contain credentials, query, or hash`);
	return trimmed.replace(/\/+$/, "");
}

function cloneModels(models: readonly Model[]): Model[] {
	return models.map((model) => ({
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		...(model.chatCompletionsCompat ? { chatCompletionsCompat: { ...model.chatCompletionsCompat } } : {}),
	}));
}

async function waitForBackoff(
	sleep: (milliseconds: number) => Promise<void>,
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw abortError();
	if (!signal) return sleep(milliseconds);
	await Promise.race([
		sleep(milliseconds),
		new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true })),
	]);
}

async function requestWithRetry(
	fetchImpl: typeof fetch,
	sleep: (milliseconds: number) => Promise<void>,
	name: string,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	for (let attempt = 0; ; attempt += 1) {
		if (init?.signal?.aborted) throw abortError();
		let response: Response;
		try {
			response = await fetchImpl(input, init);
		} catch (cause) {
			if (init?.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause;
			if (attempt >= RETRY_DELAYS.length)
				throw new OpenAIProviderError({
					message: `${name} request connection failed`,
					kind: "connection",
					retryable: false,
					cause,
				});
			await waitForBackoff(sleep, RETRY_DELAYS[attempt], init?.signal ?? undefined);
			continue;
		}
		if (response.ok) return response;
		const retryable = [408, 409, 429, 500, 502, 503, 504].includes(response.status);
		if (!retryable || attempt >= RETRY_DELAYS.length) return response;
		try {
			await response.body?.cancel();
		} catch {
			/* discard failed response */
		}
		await waitForBackoff(sleep, RETRY_DELAYS[attempt], init?.signal ?? undefined);
	}
}

export function createOpenAIChatCompletionsProvider(options: OpenAIChatCompletionsProviderOptions = {}): Provider {
	const id = options.providerId ?? "openai-chat";
	const name = options.name ?? id;
	const apiKeyEnv = options.apiKeyEnvironmentVariable ?? "OPENAI_API_KEY";
	const baseUrlEnv = options.baseUrlEnvironmentVariable ?? "OPENAI_BASE_URL";
	const configuredModels =
		options.models ?? MODELS.filter((model) => model.provider === id && model.api === "openai-chat-completions");
	if (configuredModels.length === 0) throw new Error(`${name} provider requires at least one model`);
	for (const model of configuredModels) {
		if (model.provider !== id || model.api !== "openai-chat-completions")
			throw new Error(`${name} models must use provider "${id}" and api "openai-chat-completions"`);
	}
	const env = options.env ?? process.env;
	const apiKey = options.apiKey?.trim() || env[apiKeyEnv]?.trim();
	if (!apiKey)
		throw new OpenAIProviderError({ message: `${name} API key is required`, kind: "authentication", retryable: false });
	const configuredBaseUrl = options.baseUrl?.trim() || env[baseUrlEnv]?.trim();
	const baseUrl = configuredBaseUrl ? normalizeBaseUrl(configuredBaseUrl, name) : undefined;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const sleep =
		options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const models = cloneModels(configuredModels);
	return {
		id,
		name,
		models,
		stream(model: Model, context: Context, streamOptions?: StreamOptions): StreamResult {
			const fetchWithRetry = (input: string | URL | Request, init?: RequestInit) =>
				requestWithRetry(fetchImpl, sleep, name, input, init);
			return streamOpenAIChatCompletions(
				model,
				context,
				{ ...streamOptions, apiKey, providerName: name, baseUrl: baseUrl ?? model.baseUrl ?? options.defaultBaseUrl },
				{ fetch: fetchWithRetry, now: options.now },
			);
		},
	};
}
