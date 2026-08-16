import type { Model, Provider } from "../types.ts";
import { createResponsesProvider, type ResponsesProviderOptions } from "./responses.ts";

export interface DeepSeekProviderOptions extends ResponsesProviderOptions {
	readonly models?: readonly Model[];
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): Provider {
	return createResponsesProvider(
		{
			id: "deepseek",
			name: "DeepSeek",
			api: "deepseek-responses",
			apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
			baseUrlEnvironmentVariable: "DEEPSEEK_BASE_URL",
			defaultBaseUrl: "https://api.deepseek.com",
			isRetryableStatus: (status) => status === 429 || status === 500 || status === 503,
		},
		options,
	);
}
