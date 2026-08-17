import { streamAnthropicMessages } from "../api/anthropic-messages.ts";
import { MODELS } from "../models.generated.ts";
import type { Context, Model, Provider, StreamOptions, StreamResult } from "../types.ts";

export interface AnthropicProviderOptions {
	readonly models?: readonly Model[];
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly providerId?: string;
	readonly name?: string;
}

const RETRY_DELAYS = [250, 500] as const;

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function normalizeBaseUrl(name: string, value: string): string {
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`${name} baseUrl must be an absolute http or https URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} baseUrl must use http or https`);
	if (url.username || url.password || url.search || url.hash)
		throw new Error(`${name} baseUrl must not contain credentials, query, or hash`);
	return trimmed.replace(/\/+$/, "");
}

function wait(
	sleep: (milliseconds: number) => Promise<void>,
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	if (!signal) return sleep(milliseconds);
	return Promise.race([
		sleep(milliseconds),
		new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true })),
	]);
}

function isRetryable(status: number): boolean {
	return status === 408 || status === 429 || status === 529 || (status >= 500 && status <= 599);
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): Provider {
	const providerId = options.providerId?.trim() || "anthropic";
	const name = options.name?.trim() || (providerId === "anthropic" ? "Anthropic" : providerId);
	const configuredModels =
		options.models ?? MODELS.filter((model) => model.provider === providerId && model.api === "anthropic-messages");
	if (configuredModels.length === 0) throw new Error(`${name} provider requires at least one model`);
	for (const model of configuredModels) {
		if (model.provider !== providerId || model.api !== "anthropic-messages") {
			throw new Error(`${name} models must use provider "${providerId}" and api "anthropic-messages"`);
		}
		if (model.baseUrl?.trim()) normalizeBaseUrl(name, model.baseUrl);
	}
	const apiKey = options.apiKey?.trim() || (options.env ?? process.env).ANTHROPIC_API_KEY?.trim();
	if (!apiKey) throw new Error("Anthropic API key is required");
	const configuredBaseUrl = options.baseUrl?.trim() || (options.env ?? process.env).ANTHROPIC_BASE_URL?.trim();
	const baseUrl = configuredBaseUrl ? normalizeBaseUrl(name, configuredBaseUrl) : undefined;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const sleep =
		options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const models = configuredModels.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
	const retryFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		for (let attempt = 0; ; attempt += 1) {
			if (init?.signal?.aborted) throw abortError();
			try {
				const response = await fetchImpl(input, init);
				if (response.ok || !isRetryable(response.status) || attempt >= RETRY_DELAYS.length) return response;
				await response.body?.cancel();
			} catch (cause) {
				if (
					init?.signal?.aborted ||
					(cause instanceof DOMException && cause.name === "AbortError") ||
					attempt >= RETRY_DELAYS.length
				)
					throw cause;
			}
			await wait(sleep, RETRY_DELAYS[attempt], init?.signal ?? undefined);
		}
	};
	return {
		id: providerId,
		name,
		models,
		stream(model: Model, context: Context, streamOptions?: StreamOptions): StreamResult {
			const modelBaseUrl = model.baseUrl?.trim() ? normalizeBaseUrl(name, model.baseUrl) : "https://api.anthropic.com";
			return streamAnthropicMessages(
				model,
				context,
				{ ...streamOptions, apiKey, baseUrl: baseUrl ?? modelBaseUrl },
				{ fetch: retryFetch, now: options.now },
			);
		},
	};
}
