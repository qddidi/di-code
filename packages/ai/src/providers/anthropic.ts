import { AnthropicProviderError, streamAnthropicMessages } from "../api/anthropic-messages.ts";
import { RemoteModelCatalog } from "../model-catalog.ts";
import type { Model, ModelCatalogStore, ModelRefreshContext, Provider, StreamOptions, StreamResult } from "../types.ts";
import { ANTHROPIC_MODELS } from "./models.generated.ts";

export interface AnthropicProviderOptions {
	readonly models?: readonly Model[];
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly catalogBaseUrl?: string;
	readonly catalogStore?: ModelCatalogStore;
	readonly allowModelNetwork?: boolean;
	readonly providerId?: string;
	readonly providerName?: string;
}

function resolveApiKey(options: AnthropicProviderOptions): string {
	const key = options.apiKey?.trim() || (options.env ?? process.env).ANTHROPIC_API_KEY?.trim();
	if (!key) throw new AnthropicProviderError({ message: "Anthropic API key is required" });
	return key;
}

function resolveBaseUrl(options: AnthropicProviderOptions): string {
	const candidate =
		options.baseUrl?.trim() || (options.env ?? process.env).ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error("Anthropic baseUrl must be an absolute http or https URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Anthropic baseUrl must use http or https");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Anthropic baseUrl must not contain credentials, query, or hash");
	return candidate.replace(/\/+$/, "");
}

function assertModels(models: readonly Model[]): void {
	if (models.length === 0) throw new Error("Anthropic provider requires at least one model");
	for (const model of models)
		if (model.api !== "anthropic-messages")
			throw new Error('Anthropic provider models must use api "anthropic-messages"');
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): Provider {
	const models = options.models ?? ANTHROPIC_MODELS;
	assertModels(models);
	const apiKey = resolveApiKey(options);
	const baseUrl = resolveBaseUrl(options);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const resolvedModels = models.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
	const providerId = options.providerId ?? "anthropic";
	const catalog = new RemoteModelCatalog(providerId, resolvedModels, {
		baseUrl: options.catalogBaseUrl ?? "https://pi.dev",
		fetch: fetchImpl,
		now: options.now,
	});
	return {
		id: providerId,
		name: options.providerName ?? (providerId === "anthropic" ? "Anthropic" : providerId),
		get models() {
			return catalog.getModels();
		},
		getModels: () => catalog.getModels(),
		...(options.catalogStore
			? {
					refreshModels: (context: ModelRefreshContext) =>
						catalog.refresh({
							...context,
							store: options.catalogStore as ModelCatalogStore,
							allowNetwork: options.allowModelNetwork ?? context.allowNetwork,
						}),
				}
			: {}),
		stream(model, context, streamOptions?: StreamOptions): StreamResult {
			return streamAnthropicMessages(
				model,
				context,
				{ ...streamOptions, apiKey, baseUrl, providerId },
				{ fetch: fetchImpl, now: options.now },
			);
		},
	};
}
