import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractImageAttachments,
	imageContentFromBytes,
	loadImageInputs,
	MAX_IMAGE_INPUT_BYTES,
	MAX_IMAGE_INPUTS,
} from "../src/core/image-input.ts";

describe("loadImageInputs", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-images-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads PNG and WebP files as base64 image content", async () => {
		await writeFile(join(root, "one.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		await writeFile(join(root, "two.webp"), Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "ascii"));

		await expect(loadImageInputs(["one.png", "two.webp"], root)).resolves.toEqual([
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			{ type: "image", data: "UklGRgAAAABXRUJQVlA4IA==", mimeType: "image/webp" },
		]);
	});

	it("rejects unsupported content, oversized files, and too many attachments", async () => {
		await writeFile(join(root, "notes.txt"), "not an image", "utf8");
		await writeFile(join(root, "large.png"), Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1));

		await expect(loadImageInputs(["notes.txt"], root)).rejects.toThrow("Unsupported image format: notes.txt");
		await expect(loadImageInputs(["large.png"], root)).rejects.toThrow("Image exceeds the 5 MiB limit: large.png");
		await expect(
			loadImageInputs(
				Array.from({ length: MAX_IMAGE_INPUTS + 1 }, () => "notes.txt"),
				root,
			),
		).rejects.toThrow(`At most ${MAX_IMAGE_INPUTS} images can be attached to one prompt.`);
	});

	it("validates clipboard bytes with the same image rules as local files", () => {
		expect(imageContentFromBytes(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), "clipboard image")).toEqual({
			type: "image",
			data: "iVBORw0KGgo=",
			mimeType: "image/png",
		});
		expect(() => imageContentFromBytes(Uint8Array.from([1, 2, 3]), "clipboard image")).toThrow(
			"Unsupported image format: clipboard image",
		);
	});

	it("extracts explicit @image references from an interactive prompt", async () => {
		await writeFile(join(root, "architecture diagram.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

		await expect(extractImageAttachments('Explain @"architecture diagram.png"', root)).resolves.toEqual({
			text: "[Attached image: architecture diagram.png]\nExplain",
			images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		});
		await expect(extractImageAttachments("Explain @missing.png", root)).rejects.toThrow(
			"Image attachment was not found: missing.png",
		);
	});
});
