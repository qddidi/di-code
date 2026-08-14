import { OpenAIProviderError, streamOpenAIResponses } from "../api/openai-responses.ts";
import { MODELS } from "../models.generated.ts";
import type { Context, Model, Provider, StreamOptions, StreamResult } from "../types.ts";

export interface OpenAIProviderOptions {
	readonly models?: readonly Model[];
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const RETRY_DELAYS = [250, 500] as const;

function resolveApiKey(options: OpenAIProviderOptions): string {
	const explicit = options.apiKey?.trim();
	if (explicit) return explicit;
	const environment = (options.env ?? process.env).OPENAI_API_KEY?.trim();
	if (environment) return environment;
	throw new OpenAIProviderError({
		message: "OpenAI API key is required",
		kind: "authentication",
		retryable: false,
	});
}

function normalizeBaseUrl(candidate: string): string {
	const trimmed = candidate.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("OpenAI baseUrl must be an absolute http or https URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("OpenAI baseUrl must use http or https");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("OpenAI baseUrl must not contain credentials, query, or hash");
	}
	return trimmed.replace(/\/+$/, "");
}

function resolveConfiguredBaseUrl(options: OpenAIProviderOptions): string | undefined {
	const explicit = options.baseUrl?.trim();
	const environment = (options.env ?? process.env).OPENAI_BASE_URL?.trim();
	const candidate = explicit || environment;
	return candidate ? normalizeBaseUrl(candidate) : undefined;
}

function resolveModelBaseUrl(model: Model): string {
	return normalizeBaseUrl(model.baseUrl?.trim() || DEFAULT_BASE_URL);
}

function cloneModels(models: readonly Model[]): Model[] {
	return models.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
}

function assertModels(models: readonly Model[]): void {
	if (models.length === 0) throw new Error("OpenAI provider requires at least one model");
	for (const model of models) {
		if (model.provider !== "openai" || model.api !== "openai-responses") {
			throw new Error('OpenAI provider models must use provider "openai" and api "openai-responses"');
		}
		const baseUrl = model.baseUrl?.trim();
		if (baseUrl) normalizeBaseUrl(baseUrl);
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

async function waitForBackoff(
	sleeper: (milliseconds: number) => Promise<void>,
	milliseconds: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) throw abortError();
	if (!signal) {
		await sleeper(milliseconds);
		return;
	}
	await Promise.race([
		sleeper(milliseconds),
		new Promise<never>((_, reject) => {
			const abort = () => reject(abortError());
			signal.addEventListener("abort", abort, { once: true });
		}),
	]);
}

async function defaultSleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function readRequestError(response: Response): Promise<{ code?: string; errorType?: string }> {
	try {
		const value = (await response.clone().json()) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const error = (value as Record<string, unknown>).error;
		if (typeof error !== "object" || error === null || Array.isArray(error)) return {};
		const record = error as Record<string, unknown>;
		return {
			code: typeof record.code === "string" ? record.code : undefined,
			errorType: typeof record.type === "string" ? record.type : undefined,
		};
	} catch {
		return {};
	}
}

async function retryingFetch(
	fetchImpl: typeof fetch,
	sleeper: (milliseconds: number) => Promise<void>,
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<Response> {
	const signal = init?.signal ?? undefined;
	for (let attempt = 0; ; attempt += 1) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		let response: Response;
		try {
			response = await fetchImpl(input, init);
		} catch (cause) {
			if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause;
			if (attempt >= RETRY_DELAYS.length) {
				throw new OpenAIProviderError({
					message: "OpenAI request connection failed",
					kind: "connection",
					retryable: false,
					cause,
				});
			}
			await waitForBackoff(sleeper, RETRY_DELAYS[attempt], signal);
			continue;
		}
		if (response.ok) return response;
		const details = await readRequestError(response);
		try {
			await response.body?.cancel();
		} catch {
			// The failed response is already being discarded.
		}
		if (!isRetryableStatus(response.status) || attempt >= RETRY_DELAYS.length) {
			throw new OpenAIProviderError({
				message: `OpenAI request failed with HTTP ${response.status}`,
				kind:
					response.status === 401 || response.status === 403
						? "authentication"
						: response.status === 429
							? "rate_limit"
							: response.status >= 500
								? "server"
								: "request",
				status: response.status,
				code: details.code,
				errorType: details.errorType,
				requestId: response.headers.get("x-request-id") ?? undefined,
				retryable: false,
			});
		}
		await waitForBackoff(sleeper, RETRY_DELAYS[attempt], signal);
	}
}

/** Creates the OpenAI Provider while keeping catalog, credentials, and retry policy outside the Agent contract. */
export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
	const configuredModels =
		options.models ?? MODELS.filter((model) => model.provider === "openai" && model.api === "openai-responses");
	assertModels(configuredModels);
	const apiKey = resolveApiKey(options);
	const configuredBaseUrl = resolveConfiguredBaseUrl(options);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const sleeper = options.sleep ?? ((milliseconds: number) => defaultSleep(milliseconds, undefined));
	const models = cloneModels(configuredModels);

	return {
		id: "openai",
		name: "OpenAI",
		models,
		stream(model: Model, context: Context, streamOptions?: StreamOptions): StreamResult {
			const fetchWithRetry = (input: string | URL | Request, init?: RequestInit) =>
				retryingFetch(fetchImpl, sleeper, input, init);
			return streamOpenAIResponses(
				model,
				context,
				{ ...streamOptions, apiKey, baseUrl: configuredBaseUrl ?? resolveModelBaseUrl(model) },
				{ fetch: fetchWithRetry, now: options.now },
			);
		},
	};
}
