import type { Model } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import type { CustomProviderDefinition } from "../src/config/models-types.ts";
import { composeProviderModels } from "../src/core/model-composer.ts";

const builtIn: Model[] = [
	{
		id: "base",
		name: "Base",
		provider: "anthropic",
		api: "anthropic-messages",
		input: ["text"],
		reasoning: false,
		contextWindow: 1_000,
		maxOutputTokens: 100,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	},
];

describe("composeProviderModels", () => {
	it("upserts custom models and applies known overrides", () => {
		const definition: CustomProviderDefinition = {
			modelOverrides: { base: { name: "Base via proxy" } },
			models: [{ id: "custom", reasoning: true }],
		};

		expect(composeProviderModels("anthropic", builtIn, definition)).toEqual([
			{ ...builtIn[0], name: "Base via proxy" },
			{
				id: "custom",
				name: "custom",
				provider: "anthropic",
				api: "anthropic-messages",
				input: ["text"],
				reasoning: true,
				contextWindow: 128_000,
				maxOutputTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]);
	});

	it("uses provider defaults for a standalone custom provider", () => {
		const definition: CustomProviderDefinition = {
			baseUrl: "http://localhost:11434/v1",
			api: "openai-responses",
			models: [{ id: "local" }],
		};

		expect(composeProviderModels("ollama", [], definition)[0]).toMatchObject({
			id: "local",
			provider: "ollama",
			api: "openai-responses",
			name: "local",
		});
	});
});
