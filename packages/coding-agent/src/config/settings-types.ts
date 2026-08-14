export type ProviderName = string;

export interface ProviderSettings {
	readonly apiKeyEnv?: string;
	readonly baseUrl?: string;
}

export interface SettingsDocument {
	readonly provider?: ProviderName;
	readonly model?: string;
	readonly providers?: Partial<Record<ProviderName, ProviderSettings>>;
}

export interface SettingsLoadOptions {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly homeDir?: string;
	readonly appData?: string;
}

export interface LoadedSettings {
	readonly settings: SettingsDocument;
	readonly sources: readonly string[];
}
