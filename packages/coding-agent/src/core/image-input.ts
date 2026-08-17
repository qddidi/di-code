import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ImageContent } from "@di-code/ai";

export const MAX_IMAGE_INPUTS = 4;
export const MAX_IMAGE_INPUT_BYTES = 5 * 1024 * 1024;

const IMAGE_REFERENCE = /(^|\s)@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s@]+))/g;

function detectImageMimeType(data: Uint8Array): ImageContent["mimeType"] | undefined {
	if (
		data.length >= 8 &&
		data[0] === 137 &&
		data[1] === 80 &&
		data[2] === 78 &&
		data[3] === 71 &&
		data[4] === 13 &&
		data[5] === 10 &&
		data[6] === 26 &&
		data[7] === 10
	) {
		return "image/png";
	}
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (
		data.length >= 6 &&
		(Buffer.from(data.subarray(0, 6)).equals(Buffer.from("GIF87a")) ||
			Buffer.from(data.subarray(0, 6)).equals(Buffer.from("GIF89a")))
	) {
		return "image/gif";
	}
	if (
		data.length >= 12 &&
		Buffer.from(data.subarray(0, 4)).equals(Buffer.from("RIFF")) &&
		Buffer.from(data.subarray(8, 12)).equals(Buffer.from("WEBP"))
	) {
		return "image/webp";
	}
	return undefined;
}

function displayPath(path: string): string {
	return path.trim() || "<empty path>";
}

/** Converts already-read bytes into validated provider-neutral image content. */
export function imageContentFromBytes(data: Uint8Array, source: string): ImageContent {
	if (data.byteLength > MAX_IMAGE_INPUT_BYTES) {
		throw new Error(`Image exceeds the 5 MiB limit: ${displayPath(source)}`);
	}
	const mimeType = detectImageMimeType(data);
	if (!mimeType) throw new Error(`Unsupported image format: ${displayPath(source)}`);
	return { type: "image", data: Buffer.from(data).toString("base64"), mimeType };
}

async function loadImageInput(path: string, cwd: string): Promise<ImageContent> {
	if (path.trim().length === 0) throw new Error("Image path must not be empty.");
	const absolutePath = resolve(cwd, path);
	const metadata = await stat(absolutePath);
	if (!metadata.isFile()) throw new Error(`Image path is not a regular file: ${displayPath(path)}`);
	if (metadata.size > MAX_IMAGE_INPUT_BYTES) {
		throw new Error(`Image exceeds the 5 MiB limit: ${displayPath(path)}`);
	}

	const data = await readFile(absolutePath);
	if (data.length > MAX_IMAGE_INPUT_BYTES) {
		throw new Error(`Image exceeds the 5 MiB limit: ${displayPath(path)}`);
	}
	return imageContentFromBytes(data, path);
}

/** Reads explicitly requested local image files into the provider-neutral user-message format. */
export async function loadImageInputs(paths: readonly string[], cwd: string): Promise<ImageContent[]> {
	if (paths.length > MAX_IMAGE_INPUTS) {
		throw new Error(`At most ${MAX_IMAGE_INPUTS} images can be attached to one prompt.`);
	}
	return Promise.all(paths.map((path) => loadImageInput(path, cwd)));
}

function isMissingFileError(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/** Extracts @path image references while preserving a concise attachment label in the model prompt. */
export async function extractImageAttachments(
	text: string,
	cwd: string,
): Promise<{ text: string; images: ImageContent[] }> {
	const images: ImageContent[] = [];
	const labels: string[] = [];
	let result = "";
	let cursor = 0;

	for (const match of text.matchAll(IMAGE_REFERENCE)) {
		const index = match.index ?? 0;
		const leading = match[1] ?? "";
		const path = match[2] ?? match[3] ?? match[4] ?? "";
		result += `${text.slice(cursor, index)}${leading}`;
		cursor = index + match[0].length;
		if (images.length >= MAX_IMAGE_INPUTS) {
			throw new Error(`At most ${MAX_IMAGE_INPUTS} images can be attached to one prompt.`);
		}
		try {
			const [image] = await loadImageInputs([path], cwd);
			if (!image) throw new Error("Image attachment was not loaded.");
			images.push(image);
			labels.push(`[Attached image: ${basename(path)}]`);
		} catch (cause) {
			if (isMissingFileError(cause)) throw new Error(`Image attachment was not found: ${path}`);
			throw cause;
		}
	}

	const prompt = `${result}${text.slice(cursor)}`.replace(/[ \t]{2,}/g, " ").trim();
	return { text: [...labels, prompt].filter((value) => value.length > 0).join("\n"), images };
}
