import { describe, expect, it } from "vitest";
import { buildOpenAIChatCompletionsRequest, createKimiProvider, MODELS } from "../src/index.ts";

describe("createKimiProvider", () => {
	it("uses the Kimi Coding endpoint and KIMI_API_KEY by default", () => {
		const provider = createKimiProvider({ env: { KIMI_API_KEY: "test-kimi-key" } });

		expect(provider).toMatchObject({ id: "kimi", name: "Kimi" });
		expect(provider.models.map((model) => model.id)).toEqual([
			"k3",
			"k3-256k",
			"kimi-for-coding",
			"kimi-for-coding-highspeed",
		]);
		expect(provider.models[0]).toMatchObject({
			baseUrl: "https://api.kimi.com/coding/v1",
			api: "openai-chat-completions",
		});
		expect(MODELS.some((model) => model.provider === "kimi" && model.id === "k3")).toBe(true);
	});

	it("maps Kimi reasoning effort without DeepSeek or Zhipu thinking fields", () => {
		const model = MODELS.find((candidate) => candidate.provider === "kimi" && candidate.id === "k3");
		if (!model) throw new Error("Expected Kimi k3 model");
		const request = buildOpenAIChatCompletionsRequest(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "Solve this" }], timestamp: 1 }] },
			{ reasoningEffort: "max" },
		);

		expect(request).toMatchObject({ model: "k3", reasoning_effort: "max" });
		expect(request).not.toHaveProperty("thinking");
	});
});
