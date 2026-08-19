import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, matchesGlob, relative, resolve, sep } from "node:path";
import { resolveAllowedExistingPath } from "./path-boundary.ts";

export const DEFAULT_SEARCH_MAX_RESULTS = 200;
export const DEFAULT_SEARCH_MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export interface SearchFile {
	readonly relativePath: string;
	readonly searchPath: string;
}

export function assertSearchLimit(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

export function normalizeSearchPattern(pattern: string): string {
	const normalized = pattern.replaceAll("\\", "/").trim();
	if (normalized.length === 0) throw new Error("pattern must not be empty");
	if (normalized.startsWith("/")) throw new Error("pattern must be relative to the allowed root");
	try {
		matchesGlob("placeholder", normalized);
	} catch (cause) {
		throw new Error(`Invalid glob pattern: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	return normalized;
}

export async function resolveSearchRoot(inputPath: string | undefined, allowedRoot: string): Promise<string> {
	return resolveAllowedExistingPath(inputPath ?? ".", allowedRoot);
}

export async function* walkSearchFiles(
	rootPath: string,
	signal?: AbortSignal,
	displayRootPath = rootPath,
): AsyncGenerator<SearchFile, void, undefined> {
	const traversalRoot = await realpath(rootPath);
	const displayRoot = await realpath(displayRootPath);
	const rootMetadata = await stat(traversalRoot);
	if (rootMetadata.isFile()) {
		yield {
			relativePath: relative(displayRoot, traversalRoot).split(sep).join("/"),
			searchPath: basename(traversalRoot),
		};
		return;
	}
	if (!rootMetadata.isDirectory()) throw new Error("Search path must be a file or directory");
	const initialEntries = await readDirectoryEntries(traversalRoot);
	const pending: Array<{
		directory: string;
		entries: Awaited<ReturnType<typeof readDirectoryEntries>>;
		index: number;
	}> = [{ directory: traversalRoot, entries: initialEntries, index: 0 }];

	while (pending.length > 0) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const frame = pending[pending.length - 1];
		if (!frame) continue;
		const entry = frame.entries[frame.index++];
		if (!entry) {
			pending.pop();
			continue;
		}
		if (entry.isSymbolicLink()) continue;
		const absolutePath = resolve(frame.directory, entry.name);
		if (entry.isDirectory()) {
			pending.push({ directory: absolutePath, entries: await readDirectoryEntries(absolutePath), index: 0 });
			continue;
		}
		if (!entry.isFile()) continue;
		const relativePath = relative(displayRoot, absolutePath).split(sep).join("/");
		const searchPath = relative(traversalRoot, absolutePath).split(sep).join("/");
		yield { relativePath, searchPath };
	}
}

async function readDirectoryEntries(directory: string) {
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return entries;
}

export async function readSearchText(
	file: SearchFile,
	allowedRoot: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const safePath = await resolveAllowedExistingPath(file.relativePath, allowedRoot);
	const metadata = await stat(safePath);
	if (!metadata.isFile() || metadata.size > MAX_SEARCH_FILE_BYTES) return undefined;
	const buffer = await readFile(safePath);
	if (signal?.aborted) throw new Error("Operation aborted");
	const sampleLength = Math.min(buffer.length, 8 * 1024);
	for (let index = 0; index < sampleLength; index++) {
		if (buffer[index] === 0) return undefined;
	}
	return buffer.toString("utf8");
}

export function appendBoundedLine(lines: string[], line: string, maxOutputBytes: number): boolean {
	const separatorBytes = lines.length === 0 ? 0 : 1;
	const nextBytes = Buffer.byteLength(line, "utf8") + separatorBytes;
	const currentBytes = lines.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0);
	if (currentBytes + nextBytes > maxOutputBytes) return false;
	lines.push(line);
	return true;
}
