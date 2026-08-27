import { generateOpenAIImages, type OpenAIImagesOptions, type OpenAIImagesRequest } from "../api/openai-images.ts";
import type { ImageContent } from "../types.ts";

export interface ImageGenerationProvider {
	readonly id: string;
	readonly name: string;
	readonly generate: (
		request: Omit<OpenAIImagesRequest, "model"> & { readonly model?: string },
		options?: Pick<OpenAIImagesOptions, "signal">,
	) => Promise<readonly ImageContent[]>;
}

export interface OpenAIImagesProviderOptions extends Omit<OpenAIImagesOptions, "signal"> {
	readonly providerId?: string;
	readonly name?: string;
	readonly model?: string;
}

/** Creates an OpenAI Images-compatible generator. Any compatible gateway can override baseUrl and model. */
export function createOpenAIImagesProvider(options: OpenAIImagesProviderOptions): ImageGenerationProvider {
	const id = options.providerId?.trim() || "openai-images";
	const name = options.name?.trim() || "OpenAI Images";
	const defaultModel = options.model?.trim() || "gpt-image-1";
	return {
		id,
		name,
		generate: async (request, requestOptions) => {
			const result = await generateOpenAIImages(
				{ ...request, model: request.model?.trim() || defaultModel },
				{ ...options, signal: requestOptions?.signal },
			);
			return result.images;
		},
	};
}
