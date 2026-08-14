export type ConfiguredApi = "openai-responses" | "anthropic-messages";

export interface CustomModelDefinition {
	readonly id: string;
	readonly name?: string;
	readonly api?: ConfiguredApi;
	readonly reasoning?: boolean;
	readonly input?: readonly ("text" | "image")[];
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly cost?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>;
}

export interface CustomProviderDefinition {
	readonly name?: string;
	readonly baseUrl?: string;
	readonly api?: ConfiguredApi;
	readonly apiKeyEnv?: string;
	readonly models?: readonly CustomModelDefinition[];
	readonly modelOverrides?: Readonly<Record<string, Omit<CustomModelDefinition, "id">>>;
}

export interface ModelsDocument {
	readonly providers: Readonly<Record<string, CustomProviderDefinition>>;
}
