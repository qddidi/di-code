import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";

export const DEFAULT_READ_MAX_LINES = 2_000;
export const DEFAULT_READ_MAX_BYTES = 50 * 1024;

export const readParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type ReadParameters = Static<typeof readParameters>;

export interface ReadToolOptions {
	readonly maxLines?: number;
	readonly maxBytes?: number;
}

export type ReadTool = AgentTool<typeof readParameters>;

interface TextWindow {
	readonly content: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly totalLines: number;
	readonly truncatedBy: "limit" | "lines" | "bytes" | null;
}

function assertPositiveInteger(name: string, value: number | undefined): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
		throw new Error(`${name} must be a positive integer`);
	}
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

function selectUserWindow(lines: readonly string[], offset: number, limit: number | undefined): TextWindow {
	if (lines.length === 0) {
		if (offset > 1) throw new Error(`Offset ${offset} is beyond end of file (0 lines total)`);
		return { content: "", startLine: 1, endLine: 0, totalLines: 0, truncatedBy: null };
	}

	const startIndex = offset - 1;
	if (startIndex >= lines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
	}

	const available = lines.slice(startIndex);
	const selected = limit === undefined ? available : available.slice(0, limit);
	const endLine = offset + selected.length - 1;
	return {
		content: selected.join("\n"),
		startLine: offset,
		endLine,
		totalLines: lines.length,
		truncatedBy: limit !== undefined && selected.length < available.length ? "limit" : null,
	};
}

function applyOutputLimits(window: TextWindow, maxLines: number, maxBytes: number): TextWindow {
	if (window.content === "") return window;
	const lines = window.content.split("\n");
	const selected: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" | null = null;

	for (const line of lines) {
		if (selected.length >= maxLines) {
			truncatedBy = "lines";
			break;
		}
		const separatorBytes = selected.length === 0 ? 0 : 1;
		const nextBytes = bytes + separatorBytes + Buffer.byteLength(line, "utf8");
		if (nextBytes > maxBytes) {
			if (selected.length === 0) throw new Error("A single line exceeds the read byte limit");
			truncatedBy = "bytes";
			break;
		}
		selected.push(line);
		bytes = nextBytes;
	}

	if (truncatedBy === null && selected.length < lines.length) truncatedBy = "lines";
	if (truncatedBy === null) return window;
	return {
		...window,
		content: selected.join("\n"),
		endLine: window.startLine + selected.length - 1,
		truncatedBy,
	};
}

function formatByteLimit(maxBytes: number): string {
	if (maxBytes % 1024 === 0) return `${maxBytes / 1024} KiB`;
	return `${maxBytes} bytes`;
}

function appendContinuation(window: TextWindow, maxBytes: number): string {
	if (window.truncatedBy === null) return window.content;
	const nextOffset = window.endLine + 1;
	if (window.truncatedBy === "limit") {
		const remaining = window.totalLines - window.endLine;
		return `${window.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	}
	const reason = window.truncatedBy === "bytes" ? ` (${formatByteLimit(maxBytes)} limit)` : "";
	return `${window.content}\n\n[Showing lines ${window.startLine}-${window.endLine} of ${window.totalLines}${reason}. Use offset=${nextOffset} to continue.]`;
}

function assertInsideRoot(root: string, target: string): void {
	const fromRoot = relative(root, target);
	if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
		return;
	}
	throw new Error("Path is outside the allowed root");
}

async function resolveAllowedFile(inputPath: string, allowedRoot: string): Promise<string> {
	const rootReal = await realpath(allowedRoot);
	const candidate = resolve(rootReal, inputPath);
	assertInsideRoot(rootReal, candidate);
	const targetReal = await realpath(candidate);
	assertInsideRoot(rootReal, targetReal);
	return targetReal;
}

function containsNulByte(buffer: Buffer): boolean {
	const sampleLength = Math.min(buffer.length, 8 * 1024);
	for (let index = 0; index < sampleLength; index++) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

export function createReadTool(allowedRoot: string, options: ReadToolOptions = {}): ReadTool {
	const maxLines = options.maxLines ?? DEFAULT_READ_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
	assertPositiveInteger("maxLines", maxLines);
	assertPositiveInteger("maxBytes", maxBytes);

	return {
		name: "read",
		description: "Read a UTF-8 text file inside the allowed root. Use offset and limit for large files.",
		parameters: readParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (parameters.path.length === 0) throw new Error("path must not be empty");
			assertPositiveInteger("offset", parameters.offset);
			assertPositiveInteger("limit", parameters.limit);
			const absolutePath = await resolveAllowedFile(parameters.path, allowedRoot);
			if (signal?.aborted) throw new Error("Operation aborted");
			const buffer = await readFile(absolutePath);
			if (containsNulByte(buffer)) {
				throw new Error("Binary files are not supported by read");
			}
			const userWindow = selectUserWindow(
				splitLines(buffer.toString("utf8")),
				parameters.offset ?? 1,
				parameters.limit,
			);
			const boundedWindow = applyOutputLimits(userWindow, maxLines, maxBytes);
			return [{ type: "text", text: appendContinuation(boundedWindow, maxBytes) }];
		},
	};
}
