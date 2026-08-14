import { readFile } from "node:fs/promises";
import type { ConfiguredApi, CustomModelDefinition, CustomProviderDefinition, ModelsDocument } from "./models-types.ts";

const APIS = new Set<ConfiguredApi>(["openai-responses", "anthropic-messages"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUrl(value: unknown, path: string): string {
	if (typeof value !== "string") throw new Error(`${path} must be a URL`);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${path} must be an absolute http or https URL`);
	}
	if (
		!["http:", "https:"].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(`${path} must be a credential-free http or https URL`);
	}
	return value.replace(/\/+$/, "");
}

function validateApi(value: unknown, path: string): ConfiguredApi {
	if (typeof value !== "string" || !APIS.has(value as ConfiguredApi)) {
		throw new Error(`${path} uses an unsupported API`);
	}
	return value as ConfiguredApi;
}

function validateModel(providerId: string, value: unknown, index: number): CustomModelDefinition {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
		throw new Error(`providers.${providerId}.models[${index}].id is required`);
	}
	const model: CustomModelDefinition = {
		id: value.id,
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(value.api === undefined ? {} : { api: validateApi(value.api, `providers.${providerId}.models[${index}].api`) }),
		...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
	};
	return model;
}

function validateOverride(providerId: string, modelId: string, value: unknown): Omit<CustomModelDefinition, "id"> {
	if (!isRecord(value)) throw new Error(`providers.${providerId}.modelOverrides.${modelId} must be an object`);
	return {
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(value.api === undefined
			? {}
			: { api: validateApi(value.api, `providers.${providerId}.modelOverrides.${modelId}.api`) }),
		...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
		...(Array.isArray(value.input) && value.input.every((item) => item === "text" || item === "image")
			? { input: [...value.input] as ("text" | "image")[] }
			: {}),
	};
}

function validateProvider(providerId: string, value: unknown): CustomProviderDefinition {
	if (!isRecord(value)) throw new Error(`providers.${providerId} must be an object`);
	if ("apiKey" in value) throw new Error(`providers.${providerId}.apiKey is not allowed; use apiKeyEnv`);
	const baseUrl =
		value.baseUrl === undefined ? undefined : validateUrl(value.baseUrl, `providers.${providerId}.baseUrl`);
	const providerApi = value.api === undefined ? undefined : validateApi(value.api, `providers.${providerId}.api`);
	if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !ENV_NAME.test(value.apiKeyEnv))) {
		throw new Error(`providers.${providerId}.apiKeyEnv must be an environment variable name`);
	}
	if (value.models !== undefined && (!Array.isArray(value.models) || value.models.length === 0)) {
		throw new Error(`providers.${providerId}.models must contain at least one model when present`);
	}
	const models = value.models?.map((entry, index) => validateModel(providerId, entry, index));
	let modelOverrides: Record<string, Omit<CustomModelDefinition, "id">> | undefined;
	if (value.modelOverrides !== undefined) {
		if (!isRecord(value.modelOverrides)) throw new Error(`providers.${providerId}.modelOverrides must be an object`);
		modelOverrides = {};
		for (const [modelId, override] of Object.entries(value.modelOverrides)) {
			modelOverrides[modelId] = validateOverride(providerId, modelId, override);
		}
	}
	return {
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(baseUrl === undefined ? {} : { baseUrl }),
		...(providerApi === undefined ? {} : { api: providerApi }),
		...(value.apiKeyEnv === undefined ? {} : { apiKeyEnv: value.apiKeyEnv }),
		...(models === undefined ? {} : { models }),
		...(modelOverrides === undefined ? {} : { modelOverrides }),
	};
}

export async function loadModelsDocument(path: string): Promise<ModelsDocument> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw new Error(`Unable to read models.json ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`Invalid models.json ${path}: malformed JSON`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		throw new Error(`Invalid models.json ${path}: providers must be an object`);
	}
	const providers: Record<string, CustomProviderDefinition> = {};
	for (const [providerId, value] of Object.entries(parsed.providers)) {
		providers[providerId] = validateProvider(providerId, value);
	}
	return { providers: structuredClone(providers) };
}

export async function loadModelsDocuments(paths: readonly string[]): Promise<ModelsDocument> {
	const merged: Record<string, CustomProviderDefinition> = {};
	for (const path of paths) {
		const document = await loadModelsDocument(path);
		for (const [providerId, definition] of Object.entries(document.providers)) {
			const previous = merged[providerId];
			merged[providerId] = previous
				? {
						...previous,
						...definition,
						models: definition.models ?? previous.models,
						modelOverrides: { ...previous.modelOverrides, ...definition.modelOverrides },
					}
				: definition;
		}
	}
	return { providers: structuredClone(merged) };
}
