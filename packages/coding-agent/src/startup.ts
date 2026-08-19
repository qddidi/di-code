import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAnthropicProvider,
	createDeepSeekProvider,
	createFauxProvider,
	createKimiProvider,
	createOpenAIChatCompletionsProvider,
	createOpenAIProvider,
	createZhipuProvider,
	type FauxResponse,
	findBuiltinModel,
	type Model,
	type ModelApi,
	type Provider,
} from "@di-code/ai";
import { isLocale, type Locale } from "./i18n.ts";

export interface StartupRuntime {
	readonly provider: Provider;
	readonly model: Model;
}

export interface StartupProviderConfiguration {
	readonly id: string;
	readonly name?: string;
	readonly api?: string;
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly models?: readonly Model[];
}

export interface StartupConfiguration {
	readonly environment: Environment;
	readonly providers: readonly StartupProviderConfiguration[];
	readonly defaults?: StartupDefaults;
	readonly locale?: Locale;
}

export interface StartupDefaults {
	readonly providerId?: string;
	readonly modelId?: string;
}

export interface CustomProviderInput {
	readonly api: Exclude<ModelApi, "faux">;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly modelId: string;
}

const FAUX_RESPONSES: readonly FauxResponse[] = [
	{
		type: "success",
		content: [
			{
				type: "text",
				text: "你好，我是di-code，一个面向终端的 TypeScript AI Coding Agent，支持多 Provider 流式对话、工具调用、JSONL 会话持久化、交互式 TUI、插件扩展与 JSONL RPC 集成。",
			},
		],
	},
	{ type: "success", content: [{ type: "text", text: "当前回复为faux数据" }] },
];

const SETTINGS_FILE_NAME = "settings.json";
const SETTINGS_PATH = join(".di-code", SETTINGS_FILE_NAME);

type Environment = Readonly<Record<string, string | undefined>>;

interface SettingsFile {
	readonly defaultProvider?: string;
	readonly defaultModel?: string;
	readonly locale?: Locale;
	readonly providers: Record<
		string,
		{
			readonly name?: string;
			readonly baseUrl?: string;
			readonly apiKey?: string;
			readonly api?: string;
			readonly models?: unknown;
		}
	>;
}

export function resolveStartupArgs(args: readonly string[]): readonly string[] {
	return args.length === 0 ? ["--interactive"] : args;
}

function optionalString(value: unknown, path: string, settingsPath: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${settingsPath}: ${path} must be a string`);
	return value;
}

function requiredString(value: unknown, path: string, settingsPath = SETTINGS_PATH): string {
	const result = optionalString(value, path, settingsPath);
	if (!result?.trim()) throw new Error(`${settingsPath}: ${path} must be a non-empty string`);
	return result.trim();
}

function positiveInteger(value: unknown, path: string, fallback: number, settingsPath: string): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || (result as number) <= 0) {
		throw new Error(`${settingsPath}: ${path} must be a positive integer`);
	}
	return result as number;
}

function nonNegativeNumber(value: unknown, path: string, fallback: number, settingsPath: string): number {
	const result = value ?? fallback;
	if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
		throw new Error(`${settingsPath}: ${path} must be a non-negative finite number`);
	}
	return result;
}

function parseChatCompletionsCompat(
	value: unknown,
	path: string,
	settingsPath: string,
): Model["chatCompletionsCompat"] {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${settingsPath}: ${path} must be an object`);
	}
	const compat = value as Record<string, unknown>;
	const optionalBoolean = (field: string): boolean | undefined => {
		const candidate = compat[field];
		if (candidate === undefined) return undefined;
		if (typeof candidate !== "boolean") throw new Error(`${settingsPath}: ${path}.${field} must be a boolean`);
		return candidate;
	};
	const maxTokensField = compat.maxTokensField;
	if (maxTokensField !== undefined && maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens") {
		throw new Error(`${settingsPath}: ${path}.maxTokensField is invalid`);
	}
	const thinkingFormat = compat.thinkingFormat;
	if (
		thinkingFormat !== undefined &&
		thinkingFormat !== "zai" &&
		thinkingFormat !== "deepseek" &&
		thinkingFormat !== "kimi"
	) {
		throw new Error(`${settingsPath}: ${path}.thinkingFormat is invalid`);
	}
	const supportsUsageInStreaming = optionalBoolean("supportsUsageInStreaming");
	const supportsReasoningEffort = optionalBoolean("supportsReasoningEffort");
	const zaiToolStream = optionalBoolean("zaiToolStream");
	return {
		...(maxTokensField === undefined ? {} : { maxTokensField }),
		...(thinkingFormat === undefined ? {} : { thinkingFormat }),
		...(supportsUsageInStreaming === undefined ? {} : { supportsUsageInStreaming }),
		...(supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort }),
		...(zaiToolStream === undefined ? {} : { zaiToolStream }),
	};
}

function parseModels(
	value: unknown,
	path: string,
	providerId: string,
	providerApi: string | undefined,
	providerBaseUrl: string | undefined,
	settingsPath: string,
): readonly Model[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${settingsPath}: ${path} must be an array`);

	return value.map((entry, index) => {
		const modelPath = `${path}[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${settingsPath}: ${modelPath} must be an object`);
		}
		const model = entry as Record<string, unknown>;
		const input = model.input ?? ["text"];
		if (!Array.isArray(input) || input.length === 0 || input.some((item) => item !== "text" && item !== "image")) {
			throw new Error(`${settingsPath}: ${modelPath}.input must contain text and/or image`);
		}
		const cost = model.cost ?? {};
		if (typeof cost !== "object" || cost === null || Array.isArray(cost)) {
			throw new Error(`${settingsPath}: ${modelPath}.cost must be an object`);
		}
		const prices = cost as Record<string, unknown>;
		if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
			throw new Error(`${settingsPath}: ${modelPath}.reasoning must be a boolean`);
		}
		const configuredReasoningEfforts = model.reasoningEfforts;
		if (configuredReasoningEfforts !== undefined) {
			if (!Array.isArray(configuredReasoningEfforts) || configuredReasoningEfforts.length === 0) {
				throw new Error(`${settingsPath}: ${modelPath}.reasoningEfforts must be a non-empty array`);
			}
			if (
				model.reasoning !== true ||
				configuredReasoningEfforts.some(
					(effort) => effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "max",
				) ||
				new Set(configuredReasoningEfforts).size !== configuredReasoningEfforts.length
			) {
				throw new Error(
					`${settingsPath}: ${modelPath}.reasoningEfforts requires reasoning=true and unique low, medium, high, or max values`,
				);
			}
		}
		if (model.cacheRetention !== undefined && model.cacheRetention !== "long") {
			throw new Error(`${settingsPath}: ${modelPath}.cacheRetention must be "long" when provided`);
		}
		if (model.sessionAffinity !== undefined && model.sessionAffinity !== "codex") {
			throw new Error(`${settingsPath}: ${modelPath}.sessionAffinity must be "codex" when provided`);
		}
		const api = optionalString(model.api, `${modelPath}.api`, settingsPath) ?? providerApi;
		if (!api) throw new Error(`${settingsPath}: ${modelPath}.api is required`);
		if (!["faux", "openai-responses", "openai-chat-completions", "anthropic-messages"].includes(api)) {
			throw new Error(`${settingsPath}: ${modelPath}.api is unsupported`);
		}
		const typedApi = api as ModelApi;
		const reasoningEfforts: Model["reasoningEfforts"] =
			configuredReasoningEfforts === undefined && model.reasoning === true && api === "openai-responses"
				? ["low", "medium", "high"]
				: configuredReasoningEfforts === undefined
					? undefined
					: ([...configuredReasoningEfforts] as Model["reasoningEfforts"]);
		const baseUrl = optionalString(model.baseUrl, `${modelPath}.baseUrl`, settingsPath) ?? providerBaseUrl;
		const id = requiredString(model.id, `${modelPath}.id`, settingsPath);
		const chatCompletionsCompat = parseChatCompletionsCompat(
			model.chatCompletionsCompat,
			`${modelPath}.chatCompletionsCompat`,
			settingsPath,
		);
		if (chatCompletionsCompat !== undefined && typedApi !== "openai-chat-completions") {
			throw new Error(`${settingsPath}: ${modelPath}.chatCompletionsCompat requires api "openai-chat-completions"`);
		}
		return {
			id,
			name: requiredString(model.name ?? id, `${modelPath}.name`, settingsPath),
			provider: providerId,
			api: typedApi,
			...(baseUrl === undefined ? {} : { baseUrl }),
			input: [...input],
			reasoning: model.reasoning ?? false,
			...(reasoningEfforts ? { reasoningEfforts } : {}),
			...(chatCompletionsCompat ? { chatCompletionsCompat } : {}),
			...(model.cacheRetention === "long" ? { cacheRetention: "long" as const } : {}),
			...(model.sessionAffinity === "codex" ? { sessionAffinity: "codex" as const } : {}),
			contextWindow: positiveInteger(model.contextWindow, `${modelPath}.contextWindow`, 128_000, settingsPath),
			maxOutputTokens: positiveInteger(
				model.maxTokens ?? model.maxOutputTokens,
				`${modelPath}.maxTokens`,
				16_384,
				settingsPath,
			),
			cost: {
				input: nonNegativeNumber(prices.input, `${modelPath}.cost.input`, 0, settingsPath) / 1_000_000,
				output: nonNegativeNumber(prices.output, `${modelPath}.cost.output`, 0, settingsPath) / 1_000_000,
				cacheRead: nonNegativeNumber(prices.cacheRead, `${modelPath}.cost.cacheRead`, 0, settingsPath) / 1_000_000,
				cacheWrite: nonNegativeNumber(prices.cacheWrite, `${modelPath}.cost.cacheWrite`, 0, settingsPath) / 1_000_000,
			},
		};
	});
}

/** Validates a Custom onboarding endpoint without issuing a network request. */
export function validateCustomBaseUrl(value: string): string {
	const baseUrl = value.trim();
	if (!baseUrl) throw new Error("Base URL cannot be empty.");
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Base URL must be an absolute http or https URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must use http or https.");
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Base URL must not contain credentials, query, or hash.");
	}
	if (baseUrl.endsWith("/")) throw new Error("Base URL must not end with /.");
	return baseUrl;
}

function requireCustomValue(value: string, field: "apiKey" | "modelId"): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field === "apiKey" ? "API key" : "Model ID"} cannot be empty.`);
	return trimmed;
}

/** Builds the single user-managed Custom provider from validated onboarding input. */
export function createCustomProviderConfiguration(input: CustomProviderInput): StartupProviderConfiguration {
	const baseUrl = validateCustomBaseUrl(input.baseUrl);
	const modelId = requireCustomValue(input.modelId, "modelId");
	const apiKey = requireCustomValue(input.apiKey, "apiKey");
	const known = findBuiltinModel(input.api, modelId);
	const model: Model = known
		? {
				...known,
				id: modelId,
				provider: "custom",
				api: input.api,
				baseUrl,
			}
		: {
				id: modelId,
				name: modelId,
				provider: "custom",
				api: input.api,
				baseUrl,
				input: ["text"],
				reasoning: false,
				contextWindow: 128_000,
				maxOutputTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
	return { id: "custom", name: "Custom", api: input.api, apiKey, baseUrl, models: [model] };
}

function serializeModel(model: Model): Record<string, unknown> {
	return {
		id: model.id,
		name: model.name,
		input: model.input,
		reasoning: model.reasoning,
		...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
		...(model.chatCompletionsCompat ? { chatCompletionsCompat: model.chatCompletionsCompat } : {}),
		...(model.cacheRetention ? { cacheRetention: model.cacheRetention } : {}),
		...(model.sessionAffinity ? { sessionAffinity: model.sessionAffinity } : {}),
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutputTokens,
		cost: Object.fromEntries(Object.entries(model.cost).map(([key, value]) => [key, value * 1_000_000])),
	};
}

function parseSettings(value: unknown, settingsPath: string): SettingsFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${settingsPath}: root value must be an object`);
	}
	const record = value as Record<string, unknown>;
	const providersValue = record.providers;
	if (typeof providersValue !== "object" || providersValue === null || Array.isArray(providersValue)) {
		throw new Error(`${settingsPath}: providers must be an object`);
	}
	const providers: Record<string, SettingsFile["providers"][string]> = {};
	for (const [id, entry] of Object.entries(providersValue as Record<string, unknown>)) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${settingsPath}: providers.${id} must be an object`);
		}
		const provider = entry as Record<string, unknown>;
		providers[id] = {
			name: optionalString(provider.name, `providers.${id}.name`, settingsPath),
			baseUrl: optionalString(provider.baseUrl, `providers.${id}.baseUrl`, settingsPath),
			apiKey: optionalString(provider.apiKey, `providers.${id}.apiKey`, settingsPath),
			api: optionalString(provider.api, `providers.${id}.api`, settingsPath),
			models: provider.models,
		};
	}
	const defaultProvider =
		record.defaultProvider === undefined
			? undefined
			: requiredString(record.defaultProvider, "defaultProvider", settingsPath);
	const defaultModel =
		record.defaultModel === undefined ? undefined : requiredString(record.defaultModel, "defaultModel", settingsPath);
	if (record.locale !== undefined && !isLocale(record.locale)) {
		throw new Error(`${settingsPath}: locale must be "en" or "zh-CN"`);
	}
	return {
		providers,
		...(defaultProvider === undefined ? {} : { defaultProvider }),
		...(defaultModel === undefined ? {} : { defaultModel }),
		...(record.locale === undefined ? {} : { locale: record.locale }),
	};
}

async function readSettingsFile(path: string, displayPath: string): Promise<SettingsFile | undefined> {
	try {
		const source = await readFile(path, "utf8");
		if (source.trim().length === 0) return undefined;
		return parseSettings(JSON.parse(source), displayPath);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		if (cause instanceof SyntaxError) throw new Error(`${displayPath}: invalid JSON`, { cause });
		throw cause;
	}
}

function mergeSettings(
	globalSettings: SettingsFile | undefined,
	projectSettings: SettingsFile | undefined,
): SettingsFile {
	const globalProviders = globalSettings?.providers ?? {};
	const projectProviders = projectSettings?.providers ?? {};
	const providers = { ...globalProviders };
	for (const [id, projectProvider] of Object.entries(projectProviders)) {
		providers[id] = {
			...globalProviders[id],
			...(projectProvider.name === undefined ? {} : { name: projectProvider.name }),
			...(projectProvider.baseUrl === undefined ? {} : { baseUrl: projectProvider.baseUrl }),
			...(projectProvider.apiKey === undefined ? {} : { apiKey: projectProvider.apiKey }),
			...(projectProvider.api === undefined ? {} : { api: projectProvider.api }),
			...(projectProvider.models === undefined ? {} : { models: projectProvider.models }),
		};
	}
	const defaultProvider = projectSettings?.defaultProvider ?? globalSettings?.defaultProvider;
	const defaultModel =
		projectSettings?.defaultModel ??
		(projectSettings?.defaultProvider === undefined ? globalSettings?.defaultModel : undefined);
	const locale = globalSettings?.locale;
	return {
		providers,
		...(defaultProvider === undefined ? {} : { defaultProvider }),
		...(defaultModel === undefined ? {} : { defaultModel }),
		...(locale === undefined ? {} : { locale }),
	};
}

/** Persists a user-level terminal language preference without changing project settings. */
export async function saveGlobalLocale(agentDir: string, locale: Locale): Promise<void> {
	const settingsFilePath = join(agentDir, SETTINGS_FILE_NAME);
	const existingSettings = await readSettingsFile(settingsFilePath, settingsFilePath);
	const settings: SettingsFile = {
		providers: existingSettings?.providers ?? {},
		...(existingSettings?.defaultProvider === undefined ? {} : { defaultProvider: existingSettings.defaultProvider }),
		...(existingSettings?.defaultModel === undefined ? {} : { defaultModel: existingSettings.defaultModel }),
		locale,
	};
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(settingsFilePath, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function saveGlobalProviderApiKey(
	agentDir: string,
	providerId: string,
	api: Exclude<ModelApi, "faux">,
	apiKey: string,
	modelId?: string,
): Promise<void> {
	const settingsFilePath = join(agentDir, SETTINGS_FILE_NAME);
	const trimmedApiKey = apiKey.trim();
	if (!trimmedApiKey) throw new Error(`${settingsFilePath}: apiKey must be a non-empty string`);
	const existingSettings = await readSettingsFile(settingsFilePath, settingsFilePath);
	const settings = mergeSettings(existingSettings, {
		providers: { [providerId]: { api, apiKey: trimmedApiKey } },
		defaultProvider: providerId,
		...(modelId === undefined ? {} : { defaultModel: modelId }),
	});
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(settingsFilePath, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Replaces the user-managed `custom` provider while retaining other global
 * providers and preferences. The key is intentionally stored only here, never
 * in project settings or process environment.
 */
export async function saveGlobalCustomProvider(
	agentDir: string,
	input: CustomProviderInput,
): Promise<StartupProviderConfiguration> {
	const configuration = createCustomProviderConfiguration(input);
	const settingsFilePath = join(agentDir, SETTINGS_FILE_NAME);
	const existingSettings = await readSettingsFile(settingsFilePath, settingsFilePath);
	const settings = mergeSettings(existingSettings, {
		providers: {
			custom: {
				name: configuration.name,
				api: configuration.api,
				baseUrl: configuration.baseUrl,
				apiKey: configuration.apiKey,
				models: configuration.models?.map(serializeModel),
			},
		},
		defaultProvider: "custom",
		defaultModel: configuration.models?.[0]?.id,
	});
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(settingsFilePath, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	return configuration;
}

/** Removes only the persisted credential for one provider; environment variables remain untouched. */
export async function removeGlobalProviderApiKey(agentDir: string, providerId: string): Promise<boolean> {
	const settingsFilePath = join(agentDir, SETTINGS_FILE_NAME);
	const existingSettings = await readSettingsFile(settingsFilePath, settingsFilePath);
	const provider = existingSettings?.providers[providerId];
	if (!provider || provider.apiKey === undefined) return false;

	const { apiKey: _apiKey, ...providerWithoutApiKey } = provider;
	const settings: SettingsFile = {
		...existingSettings,
		providers: {
			...existingSettings.providers,
			[providerId]: providerWithoutApiKey,
		},
	};
	await writeFile(settingsFilePath, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	return true;
}

function resolveConfigValue(value: string | undefined, env: Environment): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
	if (match) {
		const name = match[1] ?? match[2];
		const resolved = env[name];
		if (!resolved?.trim()) throw new Error(`Configured apiKey environment variable "${name}" is not set.`);
		return resolved;
	}
	if (trimmed.startsWith("!")) {
		throw new Error("Command-based apiKey values are not supported by di-code; use $ENV_VAR instead.");
	}
	return value;
}

function createFauxRuntime(): StartupRuntime {
	const faux = createFauxProvider({ responses: FAUX_RESPONSES });
	return { provider: faux.provider, model: faux.model };
}

function selectProviderModel(provider: Provider, providerId: string, env: Environment): Model {
	const modelId =
		env.DI_CODE_MODEL?.trim() ||
		(providerId === "anthropic"
			? provider.models.find((candidate) => candidate.id === "claude-sonnet-4-5")?.id
			: providerId === "openai"
				? provider.models.find((candidate) => candidate.id === "gpt-4o")?.id
				: providerId === "zhipu"
					? provider.models.find((candidate) => candidate.id === "glm-5.3")?.id
					: providerId === "kimi"
						? provider.models.find((candidate) => candidate.id === "k3")?.id
						: undefined) ||
		provider.models[0]?.id;
	if (!modelId) throw new Error("DI_CODE_MODEL is required when the selected provider has no models");
	const model = provider.models.find((candidate) => candidate.id === modelId);
	if (!model) {
		const availableModels = provider.models.map((candidate) => candidate.id).join(", ");
		throw new Error(`Unknown model "${modelId}" for provider "${providerId}". Available models: ${availableModels}.`);
	}
	return model;
}

function createBuiltInRuntime(env: Environment, providerId: string): StartupRuntime | undefined {
	if (providerId === "anthropic") {
		const provider = createAnthropicProvider({ env });
		return { provider, model: selectProviderModel(provider, providerId, env) };
	}
	if (providerId === "openai") {
		const provider = createOpenAIProvider({ env });
		return { provider, model: selectProviderModel(provider, providerId, env) };
	}
	if (providerId === "deepseek") {
		const provider = createDeepSeekProvider({ env });
		return { provider, model: selectProviderModel(provider, providerId, env) };
	}
	if (providerId === "zhipu") {
		const provider = createZhipuProvider({ env });
		return { provider, model: selectProviderModel(provider, providerId, env) };
	}
	if (providerId === "kimi") {
		const provider = createKimiProvider({ env });
		return { provider, model: selectProviderModel(provider, providerId, env) };
	}
	return undefined;
}

function createConfiguredRuntime(env: Environment, configuration: StartupProviderConfiguration): StartupRuntime {
	if (
		configuration.api !== "openai-responses" &&
		configuration.api !== "openai-chat-completions" &&
		configuration.api !== "anthropic-messages"
	) {
		throw new Error(
			`Unsupported API "${configuration.api ?? "missing"}" for provider "${configuration.id}". Expected openai-responses, openai-chat-completions, or anthropic-messages.`,
		);
	}
	if (
		configuration.id !== "openai" &&
		configuration.id !== "deepseek" &&
		configuration.id !== "zhipu" &&
		configuration.id !== "kimi" &&
		configuration.id !== "anthropic" &&
		!configuration.models
	) {
		throw new Error(`${SETTINGS_PATH}: providers.${configuration.id}.models is required for a custom provider`);
	}
	const provider =
		configuration.api === "openai-chat-completions"
			? createOpenAIChatCompletionsProvider({
					env:
						configuration.id === "zhipu" || configuration.id === "deepseek" || configuration.id === "kimi"
							? env
							: Object.fromEntries(
									Object.entries(env).filter(([name]) => name !== "OPENAI_API_KEY" && name !== "OPENAI_BASE_URL"),
								),
					models: configuration.models,
					apiKey: resolveConfigValue(configuration.apiKey, env),
					baseUrl: configuration.models ? undefined : configuration.baseUrl,
					providerId: configuration.id,
					name: configuration.name ?? configuration.id,
					...(configuration.id === "zhipu"
						? {
								apiKeyEnvironmentVariable: "ZAI_API_KEY",
								baseUrlEnvironmentVariable: "ZHIPU_BASE_URL",
								defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
							}
						: configuration.id === "deepseek"
							? {
									apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
									baseUrlEnvironmentVariable: "DEEPSEEK_BASE_URL",
									defaultBaseUrl: "https://api.deepseek.com",
								}
							: configuration.id === "kimi"
								? {
										apiKeyEnvironmentVariable: "KIMI_API_KEY",
										baseUrlEnvironmentVariable: "KIMI_BASE_URL",
										defaultBaseUrl: "https://api.kimi.com/coding/v1",
									}
								: {}),
				})
			: configuration.api === "anthropic-messages"
				? createAnthropicProvider({
						env:
							configuration.id === "anthropic"
								? env
								: Object.fromEntries(
										Object.entries(env).filter(
											([name]) => name !== "ANTHROPIC_API_KEY" && name !== "ANTHROPIC_BASE_URL",
										),
									),
						models: configuration.models,
						apiKey: resolveConfigValue(configuration.apiKey, env),
						baseUrl: configuration.models ? undefined : configuration.baseUrl,
						providerId: configuration.id,
						name: configuration.name,
					})
				: configuration.id === "deepseek"
					? createDeepSeekProvider({
							env,
							models: configuration.models,
							apiKey: resolveConfigValue(configuration.apiKey, env),
							baseUrl: configuration.models ? undefined : configuration.baseUrl,
						})
					: configuration.id === "zhipu"
						? createZhipuProvider({
								env,
								models: configuration.models,
								apiKey: resolveConfigValue(configuration.apiKey, env),
								baseUrl: configuration.models ? undefined : configuration.baseUrl,
							})
						: createOpenAIProvider({
								env:
									configuration.id === "openai"
										? env
										: Object.fromEntries(
												Object.entries(env).filter(([name]) => name !== "OPENAI_API_KEY" && name !== "OPENAI_BASE_URL"),
											),
								models: configuration.models,
								apiKey: resolveConfigValue(configuration.apiKey, env),
								baseUrl: configuration.models ? undefined : configuration.baseUrl,
								providerId: configuration.id,
								name: configuration.name,
							});
	const model = selectProviderModel(provider, configuration.id, env);
	return { provider, model };
}

export function resolveStartupRuntime(
	env: Environment,
	providers: readonly StartupProviderConfiguration[],
	defaults: StartupDefaults = {},
): StartupRuntime {
	const selectedProviderId =
		env.DI_CODE_PROVIDER?.trim() || defaults.providerId || (providers.length === 1 ? providers[0]?.id : undefined);
	if (selectedProviderId === "faux") return createFauxRuntime();
	if (!selectedProviderId) {
		if (providers.length === 0) {
			throw new Error("Provider is not configured. Set DI_CODE_PROVIDER or start interactive mode in a TTY.");
		}
		throw new Error("DI_CODE_PROVIDER is required when more than one provider is configured.");
	}
	const runtimeEnvironment =
		env.DI_CODE_MODEL?.trim() || defaults.providerId !== selectedProviderId || !defaults.modelId
			? env
			: { ...env, DI_CODE_MODEL: defaults.modelId };
	const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
	if (selectedProvider) return createConfiguredRuntime(runtimeEnvironment, selectedProvider);
	const builtInRuntime = createBuiltInRuntime(runtimeEnvironment, selectedProviderId);
	if (builtInRuntime) return builtInRuntime;
	throw new Error(
		`Unknown configured provider "${selectedProviderId}". Available providers: ${providers.map((provider) => provider.id).join(", ")}.`,
	);
}

export async function loadStartupConfiguration(
	cwd: string,
	environment: Environment = process.env,
	agentDir = join(homedir(), ".di-code"),
): Promise<StartupConfiguration> {
	const [globalSettings, projectSettings] = await Promise.all([
		readSettingsFile(join(agentDir, SETTINGS_FILE_NAME), join(agentDir, SETTINGS_FILE_NAME)),
		readSettingsFile(join(cwd, SETTINGS_PATH), SETTINGS_PATH),
	]);
	const settings = mergeSettings(globalSettings, projectSettings);
	const requestedLocale = environment.DI_CODE_LOCALE?.trim();
	if (requestedLocale !== undefined && requestedLocale !== "" && !isLocale(requestedLocale)) {
		throw new Error('DI_CODE_LOCALE must be "en" or "zh-CN".');
	}

	const providers = Object.entries(settings.providers).map(([id, provider]) => ({
		id: requiredString(id, `providers.${id}`),
		name: provider.name,
		api: provider.api,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		models: parseModels(provider.models, `providers.${id}.models`, id, provider.api, provider.baseUrl, SETTINGS_PATH),
	}));
	const defaults =
		settings.defaultProvider === undefined && settings.defaultModel === undefined
			? undefined
			: { providerId: settings.defaultProvider, modelId: settings.defaultModel };
	const locale = requestedLocale && isLocale(requestedLocale) ? requestedLocale : settings.locale;
	return {
		environment,
		providers,
		...(locale === undefined ? {} : { locale }),
		...(defaults === undefined ? {} : { defaults }),
	};
}

export async function loadStartupEnvironment(
	cwd: string,
	environment: Environment = process.env,
): Promise<Environment> {
	return (await loadStartupConfiguration(cwd, environment)).environment;
}
