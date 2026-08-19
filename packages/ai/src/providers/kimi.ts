import {
	createOpenAIChatCompletionsProvider,
	type OpenAIChatCompletionsProviderOptions,
} from "./openai-chat-completions.ts";

export interface KimiProviderOptions extends OpenAIChatCompletionsProviderOptions {}

/** Kimi Coding OpenAI-compatible endpoint. */
export function createKimiProvider(options: KimiProviderOptions = {}) {
	return createOpenAIChatCompletionsProvider({
		...options,
		providerId: "kimi",
		name: "Kimi",
		apiKeyEnvironmentVariable: "KIMI_API_KEY",
		baseUrlEnvironmentVariable: "KIMI_BASE_URL",
		defaultBaseUrl: "https://api.kimi.com/coding/v1",
	});
}
