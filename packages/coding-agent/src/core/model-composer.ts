import type { Model } from "@di-code/ai";
import type { CustomProviderDefinition } from "../config/models-types.ts";

export function composeProviderModels(
	providerId: string,
	baseline: readonly Model[],
	definition: CustomProviderDefinition,
): Model[] {
	const models = baseline.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } }));
	const defaultApi = definition.api ?? models[0]?.api ?? "openai-responses";
	for (const custom of definition.models ?? []) {
		const model: Model = {
			id: custom.id,
			name: custom.name ?? custom.id,
			provider: providerId,
			api: custom.api ?? defaultApi,
			input: [...(custom.input ?? ["text"])] as ("text" | "image")[],
			reasoning: custom.reasoning ?? false,
			contextWindow: custom.contextWindow ?? 128_000,
			maxOutputTokens: custom.maxOutputTokens ?? 16_384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...custom.cost },
		};
		const index = models.findIndex((entry) => entry.id === model.id);
		if (index >= 0) models[index] = model;
		else models.push(model);
	}
	for (const [id, override] of Object.entries(definition.modelOverrides ?? {})) {
		const index = models.findIndex((entry) => entry.id === id);
		if (index < 0) continue;
		models[index] = {
			...models[index],
			...override,
			...(override.input ? { input: [...override.input] as ("text" | "image")[] } : {}),
			provider: providerId,
			id,
			...(override.cost ? { cost: { ...models[index].cost, ...override.cost } } : {}),
		} as Model;
	}
	return models;
}
