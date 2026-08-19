import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ImageContent } from "@di-code/ai";
import { imageContentFromBytes } from "./image-input.ts";
import { workspaceStorageKey } from "./user-data.ts";

interface ClipboardModule {
	hasImage(): boolean;
	getImageBinary(): Promise<Uint8Array | readonly number[]>;
}

const CLIPBOARD_FILE_PREFIX = "di-code-clipboard-";
const CLIPBOARD_FILE_PATTERN = new RegExp(`^${CLIPBOARD_FILE_PREFIX}[0-9a-f-]+\\.(?:png|jpg|jpeg|gif|webp)$`, "i");
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

const require = createRequire(import.meta.url);

function loadClipboardModule(): ClipboardModule | undefined {
	try {
		return require("@mariozechner/clipboard") as ClipboardModule;
	} catch {
		return undefined;
	}
}

/** Reads a native clipboard image when the optional platform package is available. */
export async function readClipboardImage(): Promise<ImageContent | null> {
	const clipboard = loadClipboardModule();
	if (!clipboard?.hasImage()) return null;
	const bytes = await clipboard.getImageBinary();
	if (bytes.length === 0) return null;
	return imageContentFromBytes(Uint8Array.from(bytes), "clipboard image");
}

function extensionForMimeType(mimeType: string): string {
	switch (mimeType.toLowerCase().split(";", 1)[0]) {
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "png";
	}
}

export function clipboardImageDirectory(agentDir: string, root: string): string {
	return join(agentDir, "clipboard", workspaceStorageKey(root), String(process.pid));
}

export function isClipboardImagePath(path: string, directory: string): boolean {
	const absolutePath = resolve(path);
	return dirname(absolutePath) === resolve(directory) && CLIPBOARD_FILE_PATTERN.test(basename(absolutePath));
}

/** Removes generated clipboard images that were left by older processes for this workspace. */
export async function cleanupStaleClipboardImages(
	agentDir: string,
	root: string,
	maxAgeMs = DEFAULT_STALE_AGE_MS,
): Promise<void> {
	const workspaceDirectory = join(agentDir, "clipboard", workspaceStorageKey(root));
	let processDirectories: Dirent[];
	try {
		processDirectories = await readdir(workspaceDirectory, { withFileTypes: true });
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
		throw cause;
	}
	const cutoff = Date.now() - maxAgeMs;
	await Promise.all(
		processDirectories
			.filter((entry) => entry.isDirectory())
			.map(async (processDirectory) => {
				const directory = join(workspaceDirectory, processDirectory.name);
				try {
					const entries = await readdir(directory, { withFileTypes: true });
					await Promise.all(
						entries
							.filter((entry) => entry.isFile() && CLIPBOARD_FILE_PATTERN.test(entry.name))
							.map(async (entry) => {
								const path = join(directory, entry.name);
								try {
									if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
								} catch (cause) {
									if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
								}
							}),
					);
				} catch (cause) {
					if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
				}
			}),
	);
}

export async function removeClipboardImage(path: string, directory: string): Promise<void> {
	if (!isClipboardImagePath(path, directory)) return;
	try {
		await unlink(path);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
	}
}

/** Writes one clipboard image to a temporary file, matching Pi's editor flow. */
export async function writeImageContentToTempFile(image: ImageContent, directory = tmpdir()): Promise<string> {
	const extension = extensionForMimeType(image.mimeType);
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${CLIPBOARD_FILE_PREFIX}${randomUUID()}.${extension}`);
	await writeFile(path, Buffer.from(image.data, "base64"));
	return path;
}

/** Reads the clipboard and returns the temporary path that should be inserted into the editor. */
export async function readClipboardImagePath(directory = tmpdir()): Promise<string | null> {
	const image = await readClipboardImage();
	return image ? writeImageContentToTempFile(image, directory) : null;
}
