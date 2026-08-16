import { OpenAIProviderError, streamOpenAIResponses } from "../api/openai-responses.ts";
import { MODELS } from "../models.generated.ts";
import type { Context, Model, Provider, StreamOptions, StreamResult } from "../types.ts";

export interface ResponsesProviderOptions {
	readonly models?: readonly Model[];
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface ResponsesProviderDescriptor {
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly apiKeyEnvironmentVariable: string;
	readonly baseUrlEnvironmentVariable: string;
	readonly defaultBaseUrl: string;
	readonly isRetryableStatus: (status: number) => boolean;
}

const RETRY_DELAYS = [250, 500] as const;

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function resolveApiKey(descriptor: ResponsesProviderDescriptor, options: ResponsesProviderOptions): string {
	const explicit = options.apiKey?.trim();
	if (explicit) return explicit;
	const environment = (options.env ?? process.env)[descriptor.apiKeyEnvironmentVariable]?.trim();
	if (environment) return environment;
	throw new OpenAIProviderError({
		message: `${descriptor.name} API key is required`,
		kind: "authentication",
		retryable: false,
	});
}

function normalizeBaseUrl(descriptor: ResponsesProviderDescriptor, candidate: string): string {
	const trimmed = candidate.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`${descriptor.name} baseUrl must be an absolute http or https URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${descriptor.name} baseUrl must use http or https`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`${descriptor.name} baseUrl must not contain credentials, query, or hash`);
	}
	return trimmed.replace(/\/+$/, "");
}

function resolveConfiguredBaseUrl(
	descriptor: ResponsesProviderDescriptor,
	options: ResponsesProviderOptions,
): string | undefined {
	const explicit = options.baseUrl?.trim();
	const environment = (options.env ?? process.env)[descriptor.baseUrlEnvironmentVariable]?.trim();
	const candidate = explicit || environment;
	return candidate ? normalizeBaseUrl(descriptor, candidate) : undefined;
}

function resolveModelBaseUrl(descriptor: ResponsesProviderDescriptor, model: Model): string {
	return normalizeBaseUrl(descriptor, model.baseUrl?.trim() || descriptor.defaultBaseUrl);
}

function cloneModels(models: readonly Model[]): Model[] {
	return models.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
}

function defaultModels(descriptor: ResponsesProviderDescriptor): readonly Model[] {
	return MODELS.filter((model) => model.provider === descriptor.id && model.api === descriptor.api);
}

function assertModels(descriptor: ResponsesProviderDescriptor, models: readonly Model[]): void {
	if (models.length === 0) throw new Error(`${descriptor.name} provider requires at least one model`);
	for (const model of models) {
		if (model.provider !== descriptor.id || model.api !== descriptor.api) {
			throw new Error(
				`${descriptor.name} Responses provider models must use provider "${descriptor.id}" and api "${descriptor.api}"`,
			);
		}
		const baseUrl = model.baseUrl?.trim();
		if (baseUrl) normalizeBaseUrl(descriptor, baseUrl);
	}
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

function errorKindForStatus(status: number): OpenAIProviderError["kind"] {
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "server";
	return "request";
}

async function retryingFetch(
	descriptor: ResponsesProviderDescriptor,
	fetchImpl: typeof fetch,
	sleeper: (milliseconds: number) => Promise<void>,
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<Response> {
	const signal = init?.signal ?? undefined;
	for (let attempt = 0; ; attempt += 1) {
		if (signal?.aborted) throw abortError();
		let response: Response;
		try {
			response = await fetchImpl(input, init);
		} catch (cause) {
			if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause;
			if (attempt >= RETRY_DELAYS.length) {
				throw new OpenAIProviderError({
					message: `${descriptor.name} request connection failed`,
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
		if (!descriptor.isRetryableStatus(response.status) || attempt >= RETRY_DELAYS.length) {
			throw new OpenAIProviderError({
				message: `${descriptor.name} request failed with HTTP ${response.status}`,
				kind: errorKindForStatus(response.status),
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

export function createResponsesProvider(
	descriptor: ResponsesProviderDescriptor,
	options: ResponsesProviderOptions,
): Provider {
	const configuredModels = options.models ?? defaultModels(descriptor);
	assertModels(descriptor, configuredModels);
	const apiKey = resolveApiKey(descriptor, options);
	const configuredBaseUrl = resolveConfiguredBaseUrl(descriptor, options);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const sleeper =
		options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const models = cloneModels(configuredModels);

	return {
		id: descriptor.id,
		name: descriptor.name,
		models,
		stream(model: Model, context: Context, streamOptions?: StreamOptions): StreamResult {
			const fetchWithRetry = (input: string | URL | Request, init?: RequestInit) =>
				retryingFetch(descriptor, fetchImpl, sleeper, input, init);
			return streamOpenAIResponses(
				model,
				context,
				{ ...streamOptions, apiKey, baseUrl: configuredBaseUrl ?? resolveModelBaseUrl(descriptor, model) },
				{ fetch: fetchWithRetry, now: options.now },
			);
		},
	};
}
