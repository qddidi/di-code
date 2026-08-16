import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkGeneratedModelCatalog, MODEL_SOURCE, renderModelCatalog } from "../src/models.ts";

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
	it("advertises OpenAI image and reasoning capabilities", () => {
		const imageModel = MODEL_SOURCE.find((model) => model.id === "gpt-4o");
		const reasoningModel = MODEL_SOURCE.find((model) => model.id === "o3-mini");

		expect(imageModel?.input).toContain("image");
		expect(reasoningModel).toMatchObject({ reasoning: true, input: ["text"] });
	});

	it("advertises DeepSeek Responses models as text-only reasoning models", () => {
		const deepSeekModels = MODEL_SOURCE.filter((model) => model.provider === "deepseek");

		expect(deepSeekModels.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
		expect(deepSeekModels).toHaveLength(2);
		for (const model of deepSeekModels) {
			expect(model).toMatchObject({
				api: "deepseek-responses",
				baseUrl: "https://api.deepseek.com",
				input: ["text"],
				reasoning: true,
				contextWindow: 1_000_000,
				maxOutputTokens: 384_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		}
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
