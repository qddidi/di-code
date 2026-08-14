import type { Model, ModelInput, ModelRefreshContext } from "./types.ts";

export type { ModelCatalogEntry, ModelCatalogStore, ModelRefreshContext } from "./types.ts";

export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface RemoteModelCatalogOptions {
	readonly baseUrl: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModel(provider: string, value: unknown): Model {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.api !== "string"
	) {
		throw new Error(`Invalid model catalog entry for provider "${provider}"`);
	}
	if (!Array.isArray(value.input) || value.input.some((input) => input !== "text" && input !== "image")) {
		throw new Error(`Invalid input capability for model "${value.id}"`);
	}
	if (
		typeof value.reasoning !== "boolean" ||
		!Number.isInteger(value.contextWindow) ||
		!Number.isInteger(value.maxOutputTokens) ||
		(value.contextWindow as number) <= 0 ||
		(value.maxOutputTokens as number) <= 0
	) {
		throw new Error(`Invalid limits for model "${value.id}"`);
	}
	if (!isRecord(value.cost)) throw new Error(`Invalid cost for model "${value.id}"`);
	const cost = value.cost;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (typeof cost[field] !== "number" || !Number.isFinite(cost[field]) || cost[field] < 0) {
			throw new Error(`Invalid cost for model "${value.id}"`);
		}
	}
	return {
		id: value.id,
		name: value.name,
		provider,
		api: value.api,
		input: [...(value.input as ModelInput[])],
		reasoning: value.reasoning,
		contextWindow: value.contextWindow as number,
		maxOutputTokens: value.maxOutputTokens as number,
		cost: {
			input: cost.input as number,
			output: cost.output as number,
			cacheRead: cost.cacheRead as number,
			cacheWrite: cost.cacheWrite as number,
		},
	};
}

function parseCatalog(provider: string, value: unknown): Model[] {
	const entries = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.models)
			? value.models
			: isRecord(value)
				? Object.values(value)
			: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${provider}"`);
	return entries.map((entry) => parseModel(provider, entry));
}

function mergeModels(baseline: readonly Model[], dynamic: readonly Model[]): Model[] {
	const merged = baseline.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

export class RemoteModelCatalog {
	private dynamicModels: readonly Model[] = [];
	private inflight?: Promise<void>;
	private readonly provider: string;
	private readonly baseline: readonly Model[];
	private readonly options: RemoteModelCatalogOptions;

	constructor(provider: string, baseline: readonly Model[], options: RemoteModelCatalogOptions) {
		this.provider = provider;
		this.baseline = baseline;
		this.options = options;
	}

	getModels(): readonly Model[] {
		return mergeModels(this.baseline, this.dynamicModels);
	}

	refresh(context: ModelRefreshContext): Promise<void> {
		this.inflight ??= this.runRefresh(context).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async runRefresh(context: ModelRefreshContext): Promise<void> {
		const stored = await context.store.read();
		if (stored) this.dynamicModels = stored.models.filter((model) => model.provider === this.provider);
		if (!context.allowNetwork || context.signal?.aborted) return;

		const now = this.options.now?.() ?? Date.now();
		if (!context.force && stored && now - stored.checkedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS) return;

		const url = new URL(`/api/models/providers/${encodeURIComponent(this.provider)}`, this.options.baseUrl);
		const response = await (this.options.fetch ?? globalThis.fetch)(url, {
			headers: { accept: "application/json" },
			signal: context.signal,
		});
		if (context.signal?.aborted) return;
		const checkedAt = this.options.now?.() ?? Date.now();
		if (response.status === 404 || response.status === 501) {
			await context.store.write({ models: this.dynamicModels, checkedAt });
			return;
		}
		if (!response.ok) {
			await context.store.write({ models: this.dynamicModels, checkedAt });
			throw new Error(`Model catalog request failed for ${this.provider}: ${response.status}`);
		}
		const refreshed = parseCatalog(this.provider, await response.json());
		if (context.signal?.aborted) return;
		this.dynamicModels = refreshed;
		await context.store.write({ models: refreshed, checkedAt });
	}
}
