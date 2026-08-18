import {
	createOpenAIChatCompletionsProvider,
	type OpenAIChatCompletionsProviderOptions,
} from "./openai-chat-completions.ts";

export interface ZhipuProviderOptions extends OpenAIChatCompletionsProviderOptions {}

export function createZhipuProvider(options: ZhipuProviderOptions = {}) {
	return createOpenAIChatCompletionsProvider({
		...options,
		providerId: "zhipu",
		name: "Zhipu AI",
		apiKeyEnvironmentVariable: "ZAI_API_KEY",
		baseUrlEnvironmentVariable: "ZHIPU_BASE_URL",
		defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
	});
}
