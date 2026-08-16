import type { Model, Provider } from "../types.ts";
import {
	createResponsesProvider,
	type ResponsesProviderDescriptor,
	type ResponsesProviderOptions,
} from "./responses.ts";

export interface OpenAIProviderOptions extends ResponsesProviderOptions {
	readonly models?: readonly Model[];
	readonly providerId?: string;
	readonly name?: string;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

/** Creates the OpenAI Provider while keeping catalog, credentials, and retry policy outside the Agent contract. */
export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
	const providerId = options.providerId?.trim() || "openai";
	const name = options.name?.trim() || (providerId === "openai" ? "OpenAI" : providerId);
	const descriptor: ResponsesProviderDescriptor = {
		id: providerId,
		name,
		api: "openai-responses",
		apiKeyEnvironmentVariable: "OPENAI_API_KEY",
		baseUrlEnvironmentVariable: "OPENAI_BASE_URL",
		defaultBaseUrl: "https://api.openai.com/v1",
		isRetryableStatus,
	};
	return createResponsesProvider(descriptor, options);
}
