import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveAllowedFilePath } from "./path-boundary.ts";

export const editParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	oldText: Type.String({ minLength: 1 }),
	newText: Type.String(),
});

export type EditParameters = Static<typeof editParameters>;

export interface EditOperations {
	readFile(filePath: string): Promise<Buffer>;
	writeFile(filePath: string, content: string): Promise<void>;
}

export interface EditToolOptions {
	readonly operations?: EditOperations;
}

export type EditTool = AgentTool<typeof editParameters>;

const defaultEditOperations: EditOperations = {
	async readFile(filePath) {
		return fsReadFile(filePath);
	},
	async writeFile(filePath, content) {
		await fsWriteFile(filePath, content, "utf8");
	},
};

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function normalizeLineEndings(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
	return ending === "\n" ? text : text.replaceAll("\n", "\r\n");
}

function detectLineEnding(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function countMatches(text: string, search: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = text.indexOf(search, offset);
		if (index === -1) return count;
		count += 1;
		offset = index + 1;
	}
}

function replaceOnce(text: string, oldText: string, newText: string): string {
	const index = text.indexOf(oldText);
	return `${text.slice(0, index)}${newText}${text.slice(index + oldText.length)}`;
}

function hasUtf8Bom(bytes: Buffer): boolean {
	return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function containsNulByte(bytes: Buffer): boolean {
	const sampleLength = Math.min(bytes.length, 8 * 1024);
	for (let index = 0; index < sampleLength; index++) {
		if (bytes[index] === 0) return true;
	}
	return false;
}

function decodeUtf8(bytes: Buffer, path: string): string {
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`File is not valid UTF-8: ${path}`);
	return text;
}

export function createEditTool(allowedRoot: string, options: EditToolOptions = {}): EditTool {
	const operations = options.operations ?? defaultEditOperations;

	return {
		name: "edit",
		description: "Replace one unique exact text block in a UTF-8 text file inside the allowed root.",
		parameters: editParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			throwIfAborted(signal);
			if (parameters.path.length === 0) throw new Error("path must not be empty");
			if (parameters.oldText.length === 0) throw new Error("oldText must not be empty");
			const absolutePath = await resolveAllowedFilePath(parameters.path, allowedRoot);

			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				const originalBytes = await operations.readFile(absolutePath);
				throwIfAborted(signal);
				if (containsNulByte(originalBytes)) throw new Error("Binary files are not supported by edit");
				const hasBom = hasUtf8Bom(originalBytes);
				const originalText = decodeUtf8(originalBytes, parameters.path).replace(/^\uFEFF/, "");
				const ending = detectLineEnding(originalText);
				const content = normalizeLineEndings(originalText);
				const oldText = normalizeLineEndings(parameters.oldText);
				const newText = normalizeLineEndings(parameters.newText);
				const matches = countMatches(content, oldText);
				if (matches === 0) throw new Error(`Text to replace was not found in ${parameters.path}`);
				if (matches > 1) throw new Error(`Text to replace is ambiguous in ${parameters.path}`);

				const updatedText = restoreLineEndings(replaceOnce(content, oldText, newText), ending);
				throwIfAborted(signal);
				const currentBytes = await operations.readFile(absolutePath);
				throwIfAborted(signal);
				if (!currentBytes.equals(originalBytes)) {
					throw new Error(`File changed during edit: ${parameters.path}`);
				}
				await operations.writeFile(absolutePath, `${hasBom ? "\uFEFF" : ""}${updatedText}`);
				throwIfAborted(signal);
				return [{ type: "text", text: `Successfully replaced text in ${parameters.path}` }];
			});
		},
	};
}
