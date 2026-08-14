import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Model } from "./types.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputPath = resolve(packageRoot, "src", "models.generated.ts");

/** 唯一可手工维护的真实模型源；生成文件由本模块写出。 */
export const MODEL_SOURCE: readonly Model[] = [
	{
		id: "gpt-4o",
		name: "GPT-4o",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		reasoning: false,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "o3-mini",
		name: "o3-mini",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 100_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},{
		id: "gpt-5.6-terra",
		name: "gpt-5.6-terra",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		reasoning: true,
		contextWindow: 200_000,
		maxOutputTokens: 100_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}
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
		validatePositiveInteger(model.contextWindow, "contextWindow", label);
		validatePositiveInteger(model.maxOutputTokens, "maxOutputTokens", label);
		validateCost(model, label);
		const key = `${provider}\u0000${id}`;
		if (keys.has(key)) throw new Error(`${label} is duplicated`);
		keys.add(key);
		return { ...model, input: [...model.input], cost: { ...model.cost } };
	});

	return normalized.sort((left, right) => {
		const leftKey = `${left.provider}\u0000${left.id}`;
		const rightKey = `${right.provider}\u0000${right.id}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function renderModel(model: Model): string {
	return [
		"\t{",
		`\t\tid: ${JSON.stringify(model.id)},`,
		`\t\tname: ${JSON.stringify(model.name)},`,
		`\t\tprovider: ${JSON.stringify(model.provider)},`,
		`\t\tapi: ${JSON.stringify(model.api)},`,
		`\t\tbaseUrl: ${JSON.stringify(model.baseUrl)},`,
		`\t\tinput: [${model.input.map((input) => JSON.stringify(input)).join(", ")}],`,
		`\t\treasoning: ${model.reasoning},`,
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
