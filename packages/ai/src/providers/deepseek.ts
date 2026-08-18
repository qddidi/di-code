import {
	createOpenAIChatCompletionsProvider,
	type OpenAIChatCompletionsProviderOptions,
} from "./openai-chat-completions.ts";

export interface DeepSeekProviderOptions extends OpenAIChatCompletionsProviderOptions {}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}) {
	return createOpenAIChatCompletionsProvider({
		...options,
		providerId: "deepseek",
		name: "DeepSeek",
		apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
		baseUrlEnvironmentVariable: "DEEPSEEK_BASE_URL",
		defaultBaseUrl: "https://api.deepseek.com",
	});
}
