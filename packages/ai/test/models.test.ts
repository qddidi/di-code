import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkGeneratedModelCatalog, findBuiltinModel, MODEL_SOURCE, renderModelCatalog } from "../src/models.ts";

const generatedCatalogPath = fileURLToPath(new URL("../src/models.generated.ts", import.meta.url));
const temporaryDirectories: string[] = [];

function openAiSourceModel() {
	const model = MODEL_SOURCE.find((entry) => entry.provider === "openai" && entry.id === "gpt-4o");
	if (model === undefined) throw new Error("Expected the OpenAI source model");
	return model;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model catalog", () => {
	it("finds an exact protocol and model ID match without lending catalog state", () => {
		const known = findBuiltinModel("openai-responses", "gpt-4o");
		const mismatchedProtocol = findBuiltinModel("openai-chat-completions", "gpt-4o");
		if (known === undefined) throw new Error("Expected the OpenAI model");

		known.input.push("text");
		expect(mismatchedProtocol).toBeUndefined();
		expect(MODEL_SOURCE.find((model) => model.id === "gpt-4o")?.input).toEqual(["text", "image"]);
	});

	it("advertises only GPT-4 and GPT-5 OpenAI models", () => {
		const imageModel = MODEL_SOURCE.find((model) => model.id === "gpt-4o");

		expect(imageModel?.input).toContain("image");
		expect(
			MODEL_SOURCE.filter((model) => model.provider === "openai").every((model) => /^gpt-(4|5)/.test(model.id)),
		).toBe(true);
	});

	it("advertises current Qwen, Kimi, and MiniMax catalog models through Chat Completions", () => {
		const selectedModels = MODEL_SOURCE.filter((model) =>
			["qwen3.7-plus", "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed", "MiniMax-M3"].includes(
				model.id,
			),
		);

		expect(
			selectedModels.map(({ id, provider, api, input, contextWindow }) => ({
				id,
				provider,
				api,
				input,
				contextWindow,
			})),
		).toEqual([
			{ id: "qwen3.7-plus", provider: "qwen", api: "openai-chat-completions", input: ["text"], contextWindow: 128_000 },
			{
				id: "k3",
				provider: "kimi",
				api: "openai-chat-completions",
				input: ["text", "image"],
				contextWindow: 1_000_000,
			},
			{
				id: "k3-256k",
				provider: "kimi",
				api: "openai-chat-completions",
				input: ["text", "image"],
				contextWindow: 256_000,
			},
			{
				id: "kimi-for-coding",
				provider: "kimi",
				api: "openai-chat-completions",
				input: ["text", "image"],
				contextWindow: 256_000,
			},
			{
				id: "kimi-for-coding-highspeed",
				provider: "kimi",
				api: "openai-chat-completions",
				input: ["text", "image"],
				contextWindow: 256_000,
			},
			{
				id: "MiniMax-M3",
				provider: "minimax",
				api: "openai-chat-completions",
				input: ["text", "image"],
				contextWindow: 1_000_000,
			},
		]);
	});

	it("advertises DeepSeek Chat Completions models as text-only reasoning models", () => {
		const deepSeekModels = MODEL_SOURCE.filter((model) => model.provider === "deepseek");

		expect(deepSeekModels.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
		expect(deepSeekModels).toHaveLength(2);
		for (const model of deepSeekModels) {
			expect(model).toMatchObject({
				api: "openai-chat-completions",
				baseUrl: "https://api.deepseek.com",
				input: ["text"],
				reasoning: true,
				contextWindow: 1_000_000,
				maxOutputTokens: 384_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		}
	});

	it("advertises Anthropic Messages models with image input and token pricing", () => {
		const anthropicModels = MODEL_SOURCE.filter((model) => model.provider === "anthropic");

		expect(anthropicModels.map((model) => model.id)).toEqual([
			"claude-sonnet-4-5",
			"claude-haiku-4-5",
			"claude-opus-4-5",
			"claude-fable-5",
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
		]);
		for (const model of anthropicModels) {
			expect(model).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				input: ["text", "image"],
				reasoning: true,
			});
		}
	});

	it("advertises Zhipu GLM coding models through the Chat Completions adapter", () => {
		const zhipuModels = MODEL_SOURCE.filter((model) => model.provider === "zhipu");

		expect(zhipuModels.map((model) => model.id)).toEqual([
			"glm-5.3",
			"glm-5.2",
			"glm-5.1",
			"glm-5",
			"glm-5-turbo",
			"glm-4.7",
		]);
		expect(
			zhipuModels.map((model) => ({
				id: model.id,
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
			})),
		).toEqual([
			{ id: "glm-5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
			{ id: "glm-5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
			{ id: "glm-5.1", contextWindow: 200_000, maxOutputTokens: 128_000 },
			{ id: "glm-5", contextWindow: 200_000, maxOutputTokens: 128_000 },
			{ id: "glm-5-turbo", contextWindow: 200_000, maxOutputTokens: 128_000 },
			{ id: "glm-4.7", contextWindow: 200_000, maxOutputTokens: 128_000 },
		]);
		for (const model of zhipuModels) {
			expect(model).toMatchObject({
				api: "openai-chat-completions",
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
				input: ["text"],
				reasoning: true,
			});
		}
		expect(
			zhipuModels.map((model) => ({
				id: model.id,
				reasoningEfforts: model.reasoningEfforts,
				defaultReasoningEffort: model.defaultReasoningEffort,
				supportsReasoningEffort: model.chatCompletionsCompat?.supportsReasoningEffort,
			})),
		).toEqual([
			{
				id: "glm-5.3",
				reasoningEfforts: ["low", "high", "max"],
				defaultReasoningEffort: "max",
				supportsReasoningEffort: true,
			},
			{
				id: "glm-5.2",
				reasoningEfforts: ["low", "high", "max"],
				defaultReasoningEffort: "max",
				supportsReasoningEffort: true,
			},
			{ id: "glm-5.1", reasoningEfforts: undefined, defaultReasoningEffort: undefined, supportsReasoningEffort: false },
			{ id: "glm-5", reasoningEfforts: undefined, defaultReasoningEffort: undefined, supportsReasoningEffort: false },
			{
				id: "glm-5-turbo",
				reasoningEfforts: undefined,
				defaultReasoningEffort: undefined,
				supportsReasoningEffort: false,
			},
			{ id: "glm-4.7", reasoningEfforts: undefined, defaultReasoningEffort: undefined, supportsReasoningEffort: false },
		]);
	});

	it("sorts entries by provider then model id", () => {
		const openAiModel = openAiSourceModel();

		const output = renderModelCatalog([
			{ ...openAiModel, provider: "z-provider", id: "a-model", name: "Z provider model" },
			{ ...openAiModel, provider: "a-provider", id: "z-model", name: "A provider Z model" },
			{ ...openAiModel, provider: "a-provider", id: "a-model", name: "A provider A model" },
		]);

		const firstProvider = output.indexOf('provider: "a-provider"');
		const secondModel = output.indexOf('id: "z-model"');
		const lastProvider = output.indexOf('provider: "z-provider"');
		expect(firstProvider).toBeLessThan(secondModel);
		expect(secondModel).toBeLessThan(lastProvider);
	});

	it("rejects a model endpoint outside http or https", () => {
		const openAiModel = openAiSourceModel();

		expect(() => renderModelCatalog([{ ...openAiModel, baseUrl: "file:///tmp/model" }])).toThrow(
			"baseUrl must use http or https",
		);
	});

	it("rejects credentials embedded in a model endpoint", () => {
		const openAiModel = openAiSourceModel();

		expect(() => renderModelCatalog([{ ...openAiModel, baseUrl: "https://user:secret@example.com/v1" }])).toThrow(
			"baseUrl must not contain credentials, query, or hash",
		);
	});

	it("rejects duplicate provider and model ids", () => {
		const openAiModel = openAiSourceModel();

		expect(() => renderModelCatalog([openAiModel, { ...openAiModel }])).toThrow("model(openai/gpt-4o) is duplicated");
	});

	it("reports a stale generated catalog", async () => {
		const directory = await mkdtemp(join(tmpdir(), "di-code-model-catalog-"));
		temporaryDirectories.push(directory);
		const outputPath = join(directory, "models.generated.ts");
		await writeFile(outputPath, "stale\n", "utf8");

		await expect(checkGeneratedModelCatalog(outputPath)).rejects.toThrow("Generated model catalog is stale");
	});

	it("keeps the committed generated catalog current", async () => {
		await expect(checkGeneratedModelCatalog(generatedCatalogPath)).resolves.toBeUndefined();
	});
});
