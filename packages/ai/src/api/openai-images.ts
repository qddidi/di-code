import type { ImageContent } from "../types.ts";

export interface OpenAIImagesRequest {
	readonly model: string;
	readonly prompt: string;
	readonly n?: number;
	readonly size?: string;
	readonly quality?: string;
	readonly response_format?: "b64_json" | "url";
}

export interface OpenAIImagesResponseData {
	readonly b64_json?: string;
	readonly url?: string;
	readonly revised_prompt?: string;
}

export interface OpenAIImagesResponse {
	readonly data?: readonly OpenAIImagesResponseData[];
}

export interface OpenAIImagesOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

export interface OpenAIImagesResult {
	readonly images: readonly ImageContent[];
	readonly revisedPrompts: readonly (string | undefined)[];
}

export const OPENAI_IMAGES_MAX_BYTES = 5 * 1024 * 1024;

function normalizeBaseUrl(baseUrl: string | undefined): string {
	const value = (baseUrl ?? "https://api.openai.com/v1").trim();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("OpenAI Images baseUrl must be an absolute http or https URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("OpenAI Images baseUrl must use http or https");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("OpenAI Images baseUrl must not contain credentials, query, or hash");
	}
	return value.replace(/\/+$/, "");
}

function assertBase64(data: string): void {
	if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		throw new Error("OpenAI Images response contained invalid base64 image data");
	}
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const bytes = Math.floor((data.length * 3) / 4) - padding;
	if (bytes <= 0 || bytes > OPENAI_IMAGES_MAX_BYTES) {
		throw new Error("OpenAI Images response exceeded the 5 MiB image limit");
	}
}

function mimeType(response: Response, url: string): string {
	const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
	if (value && /^image\/[A-Za-z0-9.+-]+$/.test(value)) return value;
	if (/\.jpe?g(?:$|\?)/i.test(url)) return "image/jpeg";
	if (/\.webp(?:$|\?)/i.test(url)) return "image/webp";
	if (/\.gif(?:$|\?)/i.test(url)) return "image/gif";
	return "image/png";
}

async function imageFromUrl(
	url: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<ImageContent> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("OpenAI Images response contained an invalid image URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OpenAI Images response contained an unsupported image URL");
	}
	const response = await fetchImpl(parsed, { signal });
	if (!response.ok) throw new Error(`OpenAI Images image download failed with HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0 || bytes.length > OPENAI_IMAGES_MAX_BYTES) {
		throw new Error("OpenAI Images response exceeded the 5 MiB image limit");
	}
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return { type: "image", data: btoa(binary), mimeType: mimeType(response, parsed.href) };
}

function parseResponse(value: unknown): readonly OpenAIImagesResponseData[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("OpenAI Images response must be an object");
	}
	const data = (value as OpenAIImagesResponse).data;
	if (!Array.isArray(data) || data.length === 0) throw new Error("OpenAI Images response contained no images");
	return data;
}

/** Calls the OpenAI Images API and normalizes each result to a validated ImageContent block. */
export async function generateOpenAIImages(
	request: OpenAIImagesRequest,
	options: OpenAIImagesOptions,
): Promise<OpenAIImagesResult> {
	if (!options.apiKey.trim()) throw new Error("OpenAI Images API key is required");
	if (!request.model.trim()) throw new Error("OpenAI Images model is required");
	if (!request.prompt.trim()) throw new Error("OpenAI Images prompt is required");
	if (request.n !== undefined && (!Number.isInteger(request.n) || request.n < 1 || request.n > 4)) {
		throw new Error("OpenAI Images n must be an integer between 1 and 4");
	}
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const response = await fetchImpl(`${normalizeBaseUrl(options.baseUrl)}/images/generations`, {
		method: "POST",
		headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
		body: JSON.stringify(request),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`OpenAI Images request failed with HTTP ${response.status}`);
	const entries = parseResponse(await response.json());
	const images: ImageContent[] = [];
	const revisedPrompts: (string | undefined)[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null)
			throw new Error("OpenAI Images response contained an invalid item");
		if (typeof entry.b64_json === "string") {
			assertBase64(entry.b64_json);
			images.push({ type: "image", data: entry.b64_json, mimeType: "image/png" });
		} else if (typeof entry.url === "string") {
			images.push(await imageFromUrl(entry.url, fetchImpl, options.signal));
		} else {
			throw new Error("OpenAI Images response item contained neither b64_json nor url");
		}
		revisedPrompts.push(typeof entry.revised_prompt === "string" ? entry.revised_prompt : undefined);
	}
	return { images, revisedPrompts };
}
