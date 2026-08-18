import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createAnthropicProvider,
	createDeepSeekProvider,
	createFauxProvider,
	createOpenAIProvider,
	createZhipuProvider,
	type FauxResponse,
	type Model,
	type Provider,
} from "@di-code/ai";

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
}

const FAUX_RESPONSES: readonly FauxResponse[] = [
	{ type: "success", content: [{ type: "text", text: "你好，我是di-code，一个面向终端的 TypeScript AI Coding Agent，支持多 Provider 流式对话、工具调用、JSONL 会话持久化、交互式 TUI、插件扩展与 JSONL RPC 集成。" }] },
	{ type: "success", content: [{ type: "text", text: "当前回复为faux数据" }] },
];

const SETTINGS_PATH = join(".di-code", "settings.json");

type Environment = Readonly<Record<string, string | undefined>>;

interface SettingsFile {
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

function optionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${SETTINGS_PATH}: ${path} must be a string`);
	return value;
}

function requiredString(value: unknown, path: string): string {
	const result = optionalString(value, path);
	if (!result?.trim()) throw new Error(`${SETTINGS_PATH}: ${path} must be a non-empty string`);
	return result.trim();
}

function positiveInteger(value: unknown, path: string, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || (result as number) <= 0) {
		throw new Error(`${SETTINGS_PATH}: ${path} must be a positive integer`);
	}
	return result as number;
}

function nonNegativeNumber(value: unknown, path: string, fallback: number): number {
	const result = value ?? fallback;
	if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
		throw new Error(`${SETTINGS_PATH}: ${path} must be a non-negative finite number`);
	}
	return result;
}

function parseModels(
	value: unknown,
	path: string,
	providerId: string,
	providerApi: string | undefined,
	providerBaseUrl: string | undefined,
): readonly Model[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${SETTINGS_PATH}: ${path} must be an array`);

	return value.map((entry, index) => {
		const modelPath = `${path}[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${SETTINGS_PATH}: ${modelPath} must be an object`);
		}
		const model = entry as Record<string, unknown>;
		const input = model.input ?? ["text"];
		if (!Array.isArray(input) || input.length === 0 || input.some((item) => item !== "text" && item !== "image")) {
			throw new Error(`${SETTINGS_PATH}: ${modelPath}.input must contain text and/or image`);
		}
		const cost = model.cost ?? {};
		if (typeof cost !== "object" || cost === null || Array.isArray(cost)) {
			throw new Error(`${SETTINGS_PATH}: ${modelPath}.cost must be an object`);
		}
		const prices = cost as Record<string, unknown>;
		if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
			throw new Error(`${SETTINGS_PATH}: ${modelPath}.reasoning must be a boolean`);
		}
		let reasoningEfforts: Model["reasoningEfforts"];
		if (model.reasoningEfforts !== undefined) {
			if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length === 0) {
				throw new Error(`${SETTINGS_PATH}: ${modelPath}.reasoningEfforts must be a non-empty array`);
			}
			if (
				model.reasoning !== true ||
				model.reasoningEfforts.some(
					(effort) => effort !== "low" && effort !== "medium" && effort !== "high",
				) ||
				new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length
			) {
				throw new Error(
					`${SETTINGS_PATH}: ${modelPath}.reasoningEfforts requires reasoning=true and unique low, medium, or high values`,
				);
			}
			reasoningEfforts = [...model.reasoningEfforts] as Model["reasoningEfforts"];
		}
		if (model.cacheRetention !== undefined && model.cacheRetention !== "long") {
			throw new Error(`${SETTINGS_PATH}: ${modelPath}.cacheRetention must be "long" when provided`);
		}
		if (model.sessionAffinity !== undefined && model.sessionAffinity !== "codex") {
			throw new Error(`${SETTINGS_PATH}: ${modelPath}.sessionAffinity must be "codex" when provided`);
		}
		const api = optionalString(model.api, `${modelPath}.api`) ?? providerApi;
		if (!api) throw new Error(`${SETTINGS_PATH}: ${modelPath}.api is required`);
		const baseUrl = optionalString(model.baseUrl, `${modelPath}.baseUrl`) ?? providerBaseUrl;
		const id = requiredString(model.id, `${modelPath}.id`);
		return {
			id,
			name: requiredString(model.name ?? id, `${modelPath}.name`),
			provider: providerId,
			api,
			...(baseUrl === undefined ? {} : { baseUrl }),
			input: [...input],
			reasoning: model.reasoning ?? false,
			...(reasoningEfforts ? { reasoningEfforts } : {}),
			...(model.cacheRetention === "long" ? { cacheRetention: "long" as const } : {}),
			...(model.sessionAffinity === "codex" ? { sessionAffinity: "codex" as const } : {}),
			contextWindow: positiveInteger(model.contextWindow, `${modelPath}.contextWindow`, 128_000),
			maxOutputTokens: positiveInteger(model.maxTokens ?? model.maxOutputTokens, `${modelPath}.maxTokens`, 16_384),
			cost: {
				input: nonNegativeNumber(prices.input, `${modelPath}.cost.input`, 0) / 1_000_000,
				output: nonNegativeNumber(prices.output, `${modelPath}.cost.output`, 0) / 1_000_000,
				cacheRead: nonNegativeNumber(prices.cacheRead, `${modelPath}.cost.cacheRead`, 0) / 1_000_000,
				cacheWrite: nonNegativeNumber(prices.cacheWrite, `${modelPath}.cost.cacheWrite`, 0) / 1_000_000,
			},
		};
	});
}

function parseSettings(value: unknown): SettingsFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${SETTINGS_PATH}: root value must be an object`);
	}
	const record = value as Record<string, unknown>;
	const providersValue = record.providers;
	if (typeof providersValue !== "object" || providersValue === null || Array.isArray(providersValue)) {
		throw new Error(`${SETTINGS_PATH}: providers must be an object`);
	}
	const providers: Record<string, SettingsFile["providers"][string]> = {};
	for (const [id, entry] of Object.entries(providersValue as Record<string, unknown>)) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${SETTINGS_PATH}: providers.${id} must be an object`);
		}
		const provider = entry as Record<string, unknown>;
		providers[id] = {
			name: optionalString(provider.name, `providers.${id}.name`),
			baseUrl: optionalString(provider.baseUrl, `providers.${id}.baseUrl`),
			apiKey: optionalString(provider.apiKey, `providers.${id}.apiKey`),
			api: optionalString(provider.api, `providers.${id}.api`),
			models: provider.models,
		};
	}
	return { providers };
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
	return undefined;
}

function createConfiguredRuntime(env: Environment, configuration: StartupProviderConfiguration): StartupRuntime {
	if (
		configuration.api !== "openai-responses" &&
		configuration.api !== "deepseek-responses" &&
		configuration.api !== "zhipu-chat-completions" &&
		configuration.api !== "anthropic-messages"
	) {
		throw new Error(
			`Unsupported API "${configuration.api ?? "missing"}" for provider "${configuration.id}". Expected openai-responses, deepseek-responses, zhipu-chat-completions, or anthropic-messages.`,
		);
	}
	if (
		configuration.id !== "openai" &&
		configuration.id !== "deepseek" &&
		configuration.id !== "zhipu" &&
		configuration.id !== "anthropic" &&
		!configuration.models
	) {
		throw new Error(`${SETTINGS_PATH}: providers.${configuration.id}.models is required for a custom provider`);
	}
	const provider =
		configuration.api === "anthropic-messages"
			? createAnthropicProvider({
					env:
						configuration.id === "anthropic"
							? env
							: Object.fromEntries(
									Object.entries(env).filter(([name]) => name !== "ANTHROPIC_API_KEY" && name !== "ANTHROPIC_BASE_URL"),
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
): StartupRuntime {
	const selectedProviderId = env.DI_CODE_PROVIDER?.trim() || (providers.length === 1 ? providers[0]?.id : undefined);
	if (selectedProviderId === "faux") return createFauxRuntime();
	if (!selectedProviderId) {
		if (providers.length === 0) {
			throw new Error("Provider is not configured. Set DI_CODE_PROVIDER or start interactive mode in a TTY.");
		}
		throw new Error("DI_CODE_PROVIDER is required when more than one provider is configured.");
	}
	const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
	if (selectedProvider) return createConfiguredRuntime(env, selectedProvider);
	const builtInRuntime = createBuiltInRuntime(env, selectedProviderId);
	if (builtInRuntime) return builtInRuntime;
	throw new Error(
		`Unknown configured provider "${selectedProviderId}". Available providers: ${providers.map((provider) => provider.id).join(", ")}.`,
	);
}

export async function loadStartupConfiguration(
	cwd: string,
	environment: Environment = process.env,
): Promise<StartupConfiguration> {
	let settings: SettingsFile;
	try {
		const source = await readFile(join(cwd, SETTINGS_PATH), "utf8");
		if (source.trim().length === 0) return { environment, providers: [] };
		settings = parseSettings(JSON.parse(source));
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
			return { environment, providers: [] };
		}
		if (cause instanceof SyntaxError) throw new Error(`${SETTINGS_PATH}: invalid JSON`, { cause });
		throw cause;
	}

	const providers = Object.entries(settings.providers).map(([id, provider]) => ({
		id: requiredString(id, `providers.${id}`),
		name: provider.name,
		api: provider.api,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		models: parseModels(provider.models, `providers.${id}.models`, id, provider.api, provider.baseUrl),
	}));
	return { environment, providers };
}

export async function loadStartupEnvironment(
	cwd: string,
	environment: Environment = process.env,
): Promise<Environment> {
	return (await loadStartupConfiguration(cwd, environment)).environment;
}
