import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@di-code/agent";
import { type ImageContent, type Static, type ToolResultContent, Type } from "@di-code/ai";
import type { ImageGenerationCapability } from "./tool-capabilities.ts";

export const generateImageParameters = Type.Object({
	prompt: Type.String({ minLength: 1 }),
	model: Type.Optional(Type.String({ minLength: 1 })),
	size: Type.Optional(Type.String({ minLength: 1 })),
	quality: Type.Optional(Type.String({ minLength: 1 })),
	n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
});

export type GenerateImageParameters = Static<typeof generateImageParameters>;
export type GenerateImageTool = AgentTool<typeof generateImageParameters, ToolResultContent[]>;

function extension(mimeType: string): string {
	if (mimeType === "image/jpeg") return ".jpg";
	if (mimeType === "image/webp") return ".webp";
	if (mimeType === "image/gif") return ".gif";
	return ".png";
}

async function saveArtifacts(
	directory: string,
	toolCallId: string,
	images: readonly ImageContent[],
): Promise<string[]> {
	await mkdir(directory, { recursive: true });
	const names: string[] = [];
	for (const [index, image] of images.entries()) {
		const name = `generated-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}-${index + 1}-${randomUUID()}${extension(image.mimeType)}`;
		await writeFile(join(directory, name), Buffer.from(image.data, "base64"), { flag: "wx" });
		names.push(name);
	}
	return names;
}

/** Delegates image generation to a configured provider and stores copies in global artifact storage. */
export function createGenerateImageTool(capability: ImageGenerationCapability): GenerateImageTool {
	return {
		name: "generate_image",
		description:
			"Generate one or more images from a natural-language prompt and return them in the assistant response.",
		parameters: generateImageParameters,
		async execute(toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			if (signal?.aborted) throw new Error("Image generation aborted");
			const images = await capability.provider.generate(
				{
					prompt: parameters.prompt,
					...(parameters.model ? { model: parameters.model } : {}),
					...(parameters.size ? { size: parameters.size } : {}),
					...(parameters.quality ? { quality: parameters.quality } : {}),
					...(parameters.n ? { n: parameters.n } : {}),
				},
				{ signal },
			);
			if (images.length === 0) throw new Error("Image provider returned no images");
			const names = await saveArtifacts(capability.artifactDirectory, toolCallId, images);
			return [
				...images,
				{ type: "text", text: `Generated ${images.length} image${images.length === 1 ? "" : "s"}.` },
				{ type: "text", text: `Saved to global artifact storage: ${names.join(", ")}` },
			];
		},
	};
}
