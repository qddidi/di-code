import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Model } from "./types.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputPath = resolve(packageRoot, "src", "models.generated.ts");
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

interface OpenAiModelOptions {
	readonly reasoning: boolean;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly input?: Model["input"];
}

function openAiModel(id: string, name: string, options: OpenAiModelOptions): Model {
	return {
		id,
		name,
		provider: "openai",
		api: "openai-responses",
		baseUrl: OPENAI_BASE_URL,
		input: options.input ?? ["text", "image"],
		reasoning: options.reasoning,
		...(options.reasoning ? { reasoningEfforts: ["low", "medium", "high"] as const } : {}),
		contextWindow: options.contextWindow,
		maxOutputTokens: options.maxOutputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** 唯一可手工维护的真实模型源；生成文件由本模块写出。 */
export const MODEL_SOURCE: readonly Model[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		cost: { input: 0.000001, output: 0.000005, cacheRead: 0.0000001, cacheWrite: 0.00000125 },
	},
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE_URL,
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		cost: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		provider: "zhipu",
		api: "openai-chat-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		input: ["text"],
		reasoning: true,
		reasoningEfforts: ["low", "medium", "high"],
		chatCompletionsCompat: {
			thinkingFormat: "zai",
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			supportsReasoningEffort: true,
			zaiToolStream: true,
		},
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "glm-5-turbo",
		name: "GLM-5 Turbo",
		provider: "zhipu",
		api: "openai-chat-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		input: ["text"],
		reasoning: true,
		reasoningEfforts: ["low", "medium", "high"],
		chatCompletionsCompat: {
			thinkingFormat: "zai",
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			supportsReasoningEffort: true,
			zaiToolStream: true,
		},
		contextWindow: 200_000,
		maxOutputTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "glm-4.7",
		name: "GLM-4.7",
		provider: "zhipu",
		api: "openai-chat-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		input: ["text"],
		reasoning: true,
		chatCompletionsCompat: {
			thinkingFormat: "zai",
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			supportsReasoningEffort: false,
			zaiToolStream: true,
		},
		contextWindow: 200_000,
		maxOutputTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		provider: "deepseek",
		api: "openai-chat-completions",
		baseUrl: "https://api.deepseek.com",
		input: ["text"],
		reasoning: true,
		chatCompletionsCompat: {
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			supportsReasoningEffort: true,
		},
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		provider: "deepseek",
		api: "openai-chat-completions",
		baseUrl: "https://api.deepseek.com",
		input: ["text"],
		reasoning: true,
		chatCompletionsCompat: {
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
			supportsReasoningEffort: true,
		},
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	openAiModel("gpt-4", "GPT-4", { reasoning: false, input: ["text"], contextWindow: 8_192, maxOutputTokens: 8_192 }),
	openAiModel("gpt-4-turbo", "GPT-4 Turbo", { reasoning: false, contextWindow: 128_000, maxOutputTokens: 4_096 }),
	openAiModel("gpt-4.1", "GPT-4.1", { reasoning: false, contextWindow: 1_047_576, maxOutputTokens: 32_768 }),
	openAiModel("gpt-4.1-mini", "GPT-4.1 mini", { reasoning: false, contextWindow: 1_047_576, maxOutputTokens: 32_768 }),
	openAiModel("gpt-4.1-nano", "GPT-4.1 nano", { reasoning: false, contextWindow: 1_047_576, maxOutputTokens: 32_768 }),
	openAiModel("gpt-4o", "GPT-4o", { reasoning: false, contextWindow: 128_000, maxOutputTokens: 16_384 }),
	openAiModel("gpt-4o-2024-05-13", "GPT-4o (2024-05-13)", {
		reasoning: false,
		contextWindow: 128_000,
		maxOutputTokens: 4_096,
	}),
	openAiModel("gpt-4o-2024-08-06", "GPT-4o (2024-08-06)", {
		reasoning: false,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	}),
	openAiModel("gpt-4o-2024-11-20", "GPT-4o (2024-11-20)", {
		reasoning: false,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	}),
	openAiModel("gpt-4o-mini", "GPT-4o mini", { reasoning: false, contextWindow: 128_000, maxOutputTokens: 16_384 }),
	openAiModel("gpt-5", "GPT-5", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5-chat-latest", "GPT-5 Chat Latest", {
		reasoning: false,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	}),
	openAiModel("gpt-5-codex", "GPT-5-Codex", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5-mini", "GPT-5 Mini", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5-nano", "GPT-5 Nano", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5-pro", "GPT-5 Pro", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.1", "GPT-5.1", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.1-chat-latest", "GPT-5.1 Chat", {
		reasoning: true,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	}),
	openAiModel("gpt-5.1-codex", "GPT-5.1 Codex", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.1-codex-max", "GPT-5.1 Codex Max", {
		reasoning: true,
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
	}),
	openAiModel("gpt-5.1-codex-mini", "GPT-5.1 Codex mini", {
		reasoning: true,
		contextWindow: 400_000,
		maxOutputTokens: 128_000,
	}),
	openAiModel("gpt-5.2", "GPT-5.2", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.2-chat-latest", "GPT-5.2 Chat", {
		reasoning: true,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	}),
	openAiModel("gpt-5.2-codex", "GPT-5.2 Codex", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.2-pro", "GPT-5.2 Pro", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.3-chat-latest", "GPT-5.3 Chat (latest)", {
		reasoning: false,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	}),
	openAiModel("gpt-5.3-codex", "GPT-5.3 Codex", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", {
		reasoning: true,
		contextWindow: 128_000,
		maxOutputTokens: 32_000,
	}),
	openAiModel("gpt-5.4", "GPT-5.4", { reasoning: true, contextWindow: 272_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.4-mini", "GPT-5.4 mini", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.4-nano", "GPT-5.4 nano", { reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.4-pro", "GPT-5.4 Pro", { reasoning: true, contextWindow: 1_050_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.5", "GPT-5.5", { reasoning: true, contextWindow: 272_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.5-pro", "GPT-5.5 Pro", { reasoning: true, contextWindow: 1_050_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.6-luna", "GPT-5.6 Luna", { reasoning: true, contextWindow: 272_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.6-sol", "GPT-5.6 Sol", { reasoning: true, contextWindow: 272_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-5.6-terra", "GPT-5.6 Terra", { reasoning: true, contextWindow: 272_000, maxOutputTokens: 128_000 }),
	openAiModel("gpt-realtime-2.1", "GPT-Realtime-2.1", {
		reasoning: true,
		contextWindow: 128_000,
		maxOutputTokens: 32_000,
	}),
	openAiModel("o1", "o1", { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 }),
	openAiModel("o1-pro", "o1-pro", { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 }),
	openAiModel("o3", "o3", { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 }),
	openAiModel("o3-deep-research", "o3-deep-research", {
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 100_000,
	}),
	openAiModel("o3-mini", "o3-mini", {
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxOutputTokens: 100_000,
	}),
	openAiModel("o3-pro", "o3-pro", { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 }),
	openAiModel("o4-mini", "o4-mini", { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 }),
	openAiModel("o4-mini-deep-research", "o4-mini-deep-research", {
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 100_000,
	}),
];

function requireNonEmptyString(value: string | undefined, field: string, label: string): string {
	if (value === undefined || value.trim().length === 0) throw new Error(`${label}.${field} must be a non-empty string`);
	if (value !== value.trim()) throw new Error(`${label}.${field} must not have surrounding whitespace`);
	return value;
}

function validateBaseUrl(value: string, label: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label}.baseUrl must be an absolute URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${label}.baseUrl must use http or https`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`${label}.baseUrl must not contain credentials, query, or hash`);
	}
	if (value.endsWith("/")) throw new Error(`${label}.baseUrl must not end with /`);
}

function validatePositiveInteger(value: number, field: string, label: string): void {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}.${field} must be a positive integer`);
}

function validateCost(model: Model, label: string): void {
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = model.cost[field];
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`${label}.cost.${field} must be a non-negative finite number`);
		}
	}
}

/** 校验并复制目录模型；返回值按 provider/id 稳定排序。 */
export function validateModelCatalog(models: readonly Model[]): Model[] {
	const keys = new Set<string>();
	const normalized = models.map((model) => {
		const provider = requireNonEmptyString(model.provider, "provider", "model");
		const id = requireNonEmptyString(model.id, "id", `model(${provider})`);
		const label = `model(${provider}/${id})`;
		requireNonEmptyString(model.name, "name", label);
		requireNonEmptyString(model.api, "api", label);
		const baseUrl = requireNonEmptyString(model.baseUrl, "baseUrl", label);
		validateBaseUrl(baseUrl, label);
		if (model.input.length === 0 || model.input.some((input) => input !== "text" && input !== "image")) {
			throw new Error(`${label}.input must contain text and/or image`);
		}
		if (new Set(model.input).size !== model.input.length) throw new Error(`${label}.input must not contain duplicates`);
		if (model.reasoningEfforts !== undefined) {
			if (!model.reasoning || model.reasoningEfforts.length === 0) {
				throw new Error(`${label}.reasoningEfforts requires a reasoning model and must not be empty`);
			}
			if (
				model.reasoningEfforts.some((effort) => effort !== "low" && effort !== "medium" && effort !== "high") ||
				new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length
			) {
				throw new Error(`${label}.reasoningEfforts must contain unique low, medium, or high values`);
			}
		}
		if (model.chatCompletionsCompat !== undefined) {
			if (model.api !== "openai-chat-completions") {
				throw new Error(`${label}.chatCompletionsCompat requires api "openai-chat-completions"`);
			}
			const compat = model.chatCompletionsCompat;
			if (typeof compat !== "object" || compat === null) {
				throw new Error(`${label}.chatCompletionsCompat must be an object`);
			}
			if (compat.supportsUsageInStreaming !== undefined && typeof compat.supportsUsageInStreaming !== "boolean")
				throw new Error(`${label}.chatCompletionsCompat.supportsUsageInStreaming must be a boolean`);
			if (
				compat.maxTokensField !== undefined &&
				compat.maxTokensField !== "max_tokens" &&
				compat.maxTokensField !== "max_completion_tokens"
			)
				throw new Error(`${label}.chatCompletionsCompat.maxTokensField is invalid`);
			if (
				compat.thinkingFormat !== undefined &&
				compat.thinkingFormat !== "zai" &&
				compat.thinkingFormat !== "deepseek"
			)
				throw new Error(`${label}.chatCompletionsCompat.thinkingFormat is invalid`);
			if (compat.supportsReasoningEffort !== undefined && typeof compat.supportsReasoningEffort !== "boolean")
				throw new Error(`${label}.chatCompletionsCompat.supportsReasoningEffort must be a boolean`);
			if (compat.zaiToolStream !== undefined && typeof compat.zaiToolStream !== "boolean")
				throw new Error(`${label}.chatCompletionsCompat.zaiToolStream must be a boolean`);
		}
		validatePositiveInteger(model.contextWindow, "contextWindow", label);
		validatePositiveInteger(model.maxOutputTokens, "maxOutputTokens", label);
		validateCost(model, label);
		const key = `${provider}\u0000${id}`;
		if (keys.has(key)) throw new Error(`${label} is duplicated`);
		keys.add(key);
		return {
			...model,
			input: [...model.input],
			...(model.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
			...(model.chatCompletionsCompat ? { chatCompletionsCompat: { ...model.chatCompletionsCompat } } : {}),
			cost: { ...model.cost },
		};
	});

	return normalized.sort((left, right) => {
		const leftKey = `${left.provider}\u0000${left.id}`;
		const rightKey = `${right.provider}\u0000${right.id}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function renderModel(model: Model): string {
	const compatLines = model.chatCompletionsCompat
		? [
				"\t\tchatCompletionsCompat: {",
				...(model.chatCompletionsCompat.thinkingFormat
					? [`\t\t\tthinkingFormat: ${JSON.stringify(model.chatCompletionsCompat.thinkingFormat)},`]
					: []),
				...(model.chatCompletionsCompat.maxTokensField
					? [`\t\t\tmaxTokensField: ${JSON.stringify(model.chatCompletionsCompat.maxTokensField)},`]
					: []),
				...(model.chatCompletionsCompat.supportsUsageInStreaming !== undefined
					? [`\t\t\tsupportsUsageInStreaming: ${model.chatCompletionsCompat.supportsUsageInStreaming},`]
					: []),
				...(model.chatCompletionsCompat.supportsReasoningEffort !== undefined
					? [`\t\t\tsupportsReasoningEffort: ${model.chatCompletionsCompat.supportsReasoningEffort},`]
					: []),
				...(model.chatCompletionsCompat.zaiToolStream !== undefined
					? [`\t\t\tzaiToolStream: ${model.chatCompletionsCompat.zaiToolStream},`]
					: []),
				"\t\t},",
			]
		: [];
	return [
		"\t{",
		`\t\tid: ${JSON.stringify(model.id)},`,
		`\t\tname: ${JSON.stringify(model.name)},`,
		`\t\tprovider: ${JSON.stringify(model.provider)},`,
		`\t\tapi: ${JSON.stringify(model.api)},`,
		`\t\tbaseUrl: ${JSON.stringify(model.baseUrl)},`,
		`\t\tinput: [${model.input.map((input) => JSON.stringify(input)).join(", ")}],`,
		`\t\treasoning: ${model.reasoning},`,
		...(model.reasoningEfforts
			? [`\t\treasoningEfforts: [${model.reasoningEfforts.map((effort) => JSON.stringify(effort)).join(", ")}],`]
			: []),
		...compatLines,
		`\t\tcontextWindow: ${model.contextWindow},`,
		`\t\tmaxOutputTokens: ${model.maxOutputTokens},`,
		`\t\tcost: { input: ${model.cost.input}, output: ${model.cost.output}, cacheRead: ${model.cost.cacheRead}, cacheWrite: ${model.cost.cacheWrite} },`,
		"\t},",
	].join("\n");
}

/** 把校验后的源数据渲染成已由 Biome 格式化的 TypeScript。 */
export function renderModelCatalog(models: readonly Model[]): string {
	const validated = validateModelCatalog(models);
	return [
		"// This file is auto-generated by src/models.ts.",
		"// Do not edit manually. Run node --experimental-strip-types packages/ai/src/models.ts.",
		"",
		'import type { Model } from "./types.ts";',
		"",
		"export const MODELS: readonly Model[] = [",
		...validated.map(renderModel),
		"];",
		"",
	].join("\n");
}

/** 写入唯一的生成物；调用方只应修改 MODEL_SOURCE 后运行它。 */
export async function generateModelCatalog(outputPath = defaultOutputPath): Promise<void> {
	await writeFile(outputPath, renderModelCatalog(MODEL_SOURCE), "utf8");
}

/** 不写磁盘，比较已提交生成物和当前源数据应产生的内容。 */
export async function checkGeneratedModelCatalog(outputPath = defaultOutputPath): Promise<void> {
	const actual = await readFile(outputPath, "utf8");
	const expected = renderModelCatalog(MODEL_SOURCE);
	if (actual !== expected) {
		throw new Error("Generated model catalog is stale. Run node --experimental-strip-types packages/ai/src/models.ts.");
	}
}

export async function runModelCatalogGenerator(args: readonly string[]): Promise<void> {
	if (args.length === 0) {
		await generateModelCatalog();
		console.log("Generated packages/ai/src/models.generated.ts.");
		return;
	}
	if (args.length === 1 && args[0] === "--check") {
		await checkGeneratedModelCatalog();
		console.log("Model catalog is current.");
		return;
	}
	throw new Error("Usage: models.ts [--check]");
}

function isMainModule(): boolean {
	const invokedPath = process.argv[1];
	return invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
}

if (isMainModule()) {
	void runModelCatalogGenerator(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
