import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	LoadedSettings,
	ProviderName,
	ProviderSettings,
	SettingsDocument,
	SettingsLoadOptions,
} from "./settings-types.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProviderSettings(value: unknown, source: string, provider: ProviderName): ProviderSettings {
	if (!isRecord(value)) throw new Error(`Invalid settings file ${source}: providers.${provider} must be an object.`);
	if ("apiKey" in value) throw new Error(`Invalid settings file ${source}: raw apiKey is not allowed; use apiKeyEnv.`);
	const result: { apiKeyEnv?: string; baseUrl?: string } = {};
	if (value.apiKeyEnv !== undefined) {
		if (typeof value.apiKeyEnv !== "string" || !ENV_NAME.test(value.apiKeyEnv)) {
			throw new Error(
				`Invalid settings file ${source}: providers.${provider}.apiKeyEnv must be an environment variable name.`,
			);
		}
		result.apiKeyEnv = value.apiKeyEnv;
	}
	if (value.baseUrl !== undefined) {
		if (typeof value.baseUrl !== "string") {
			throw new Error(`Invalid settings file ${source}: providers.${provider}.baseUrl must be a URL.`);
		}
		let url: URL;
		try {
			url = new URL(value.baseUrl);
		} catch {
			throw new Error(
				`Invalid settings file ${source}: providers.${provider}.baseUrl must be an absolute http or https URL.`,
			);
		}
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error(
				`Invalid settings file ${source}: providers.${provider}.baseUrl must be a credential-free http(s) URL.`,
			);
		}
		result.baseUrl = value.baseUrl.replace(/\/+$/, "");
	}
	return result;
}

function validateDocument(value: unknown, source: string): SettingsDocument {
	if (!isRecord(value)) throw new Error(`Invalid settings file ${source}: root must be a JSON object.`);
	if ("apiKey" in value) throw new Error(`Invalid settings file ${source}: raw apiKey is not allowed; use apiKeyEnv.`);
	const result: {
		provider?: ProviderName;
		model?: string;
		providers?: Partial<Record<ProviderName, ProviderSettings>>;
	} = {};
	if (value.provider !== undefined) {
		if (typeof value.provider !== "string" || value.provider.trim().length === 0) {
			throw new Error(`Invalid settings file ${source}: provider must be a non-empty string.`);
		}
		result.provider = value.provider;
	}
	if (value.model !== undefined) {
		if (typeof value.model !== "string" || value.model.trim().length === 0) {
			throw new Error(`Invalid settings file ${source}: model must be a non-empty string.`);
		}
		result.model = value.model;
	}
	if (value.providers !== undefined) {
		if (!isRecord(value.providers)) throw new Error(`Invalid settings file ${source}: providers must be an object.`);
		const providers: Partial<Record<ProviderName, ProviderSettings>> = {};
		for (const [name, settings] of Object.entries(value.providers)) {
			if (name.trim().length === 0)
				throw new Error(`Invalid settings file ${source}: provider name must not be empty.`);
			providers[name] = validateProviderSettings(settings, source, name);
		}
		result.providers = providers;
	}
	return result;
}

function mergeSettings(base: SettingsDocument, override: SettingsDocument): SettingsDocument {
	const providers: Partial<Record<ProviderName, ProviderSettings>> = {};
	const providerNames = new Set([...Object.keys(base.providers ?? {}), ...Object.keys(override.providers ?? {})]);
	for (const provider of providerNames) {
		const merged = { ...base.providers?.[provider], ...override.providers?.[provider] };
		if (Object.keys(merged).length > 0) providers[provider] = merged;
	}
	return {
		...base,
		...override,
		providers: Object.keys(providers).length > 0 ? providers : undefined,
	};
}

function globalSettingsPath(options: SettingsLoadOptions): string {
	const env = options.env ?? process.env;
	if (process.platform === "win32") {
		const appData = options.appData ?? env.APPDATA;
		if (appData) return join(appData, "di-code", "settings.json");
	}
	const configHome = env.XDG_CONFIG_HOME;
	return join(configHome || join(options.homeDir ?? homedir(), ".config"), "di-code", "settings.json");
}

async function readOptional(path: string): Promise<SettingsDocument | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Unable to read settings file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`Invalid settings file ${path}: malformed JSON.`);
	}
	return validateDocument(parsed, path);
}

export async function loadSettings(options: SettingsLoadOptions = {}): Promise<LoadedSettings> {
	const cwd = options.cwd ?? process.cwd();
	const paths = [globalSettingsPath(options), join(cwd, ".di-code", "settings.json")];
	let settings: SettingsDocument = {};
	const sources: string[] = [];
	for (const path of paths) {
		const document = await readOptional(path);
		if (document === undefined) continue;
		settings = mergeSettings(settings, document);
		sources.push(path);
	}
	return { settings, sources };
}
