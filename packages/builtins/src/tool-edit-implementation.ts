import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import type { AgentTool, ToolExecutionResult } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import { applyEditsToContent, type Edit, generateDiffString, generateUnifiedPatch } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveAllowedFilePath } from "./path-boundary.ts";

const editItemParameters = Type.Object({
	oldText: Type.String(),
	newText: Type.String(),
});

export const editParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	edits: Type.Optional(Type.Array(editItemParameters, { minItems: 1 })),
	// Compatibility with the original di-code single-edit contract.
	oldText: Type.Optional(Type.String()),
	newText: Type.Optional(Type.String()),
});

export type EditParameters = Static<typeof editParameters>;

export interface EditOperations {
	readFile(filePath: string): Promise<Buffer>;
	writeFile(filePath: string, content: string): Promise<void>;
}

export interface EditToolOptions {
	readonly operations?: EditOperations;
}

export interface EditToolDetails {
	readonly diff: string;
	readonly patch: string;
	readonly firstChangedLine?: number;
}

export type EditTool = AgentTool<typeof editParameters, ToolExecutionResult<EditToolDetails>>;

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

function normalizeEdits(parameters: EditParameters, path: string): Edit[] {
	if (parameters.edits) {
		return parameters.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText }));
	}
	if (typeof parameters.oldText === "string" && typeof parameters.newText === "string") {
		return [{ oldText: parameters.oldText, newText: parameters.newText }];
	}
	throw new Error(`edit requires edits[] or oldText/newText in ${path}`);
}

function legacyError(cause: unknown, path: string, legacy: boolean): never {
	if (!legacy || !(cause instanceof Error)) throw cause;
	if (cause.message.includes("oldText must not be empty")) throw cause;
	if (cause.message.includes("Could not find edits[0]")) {
		throw new Error(`Text to replace was not found in ${path}`);
	}
	if (cause.message.includes("Found ") && cause.message.includes("occurrences of edits[0]")) {
		throw new Error(`Text to replace is ambiguous in ${path}`);
	}
	throw cause;
}

export function createEditTool(allowedRoot: string, options: EditToolOptions = {}): EditTool {
	const operations = options.operations ?? defaultEditOperations;

	return {
		name: "edit",
		description:
			"Edit one UTF-8 text file using one or more unique exact replacements in edits[]. Legacy oldText/newText is also accepted.",
		parameters: editParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolExecutionResult<EditToolDetails>> {
			throwIfAborted(signal);
			if (parameters.path.length === 0) throw new Error("path must not be empty");
			if (parameters.edits === undefined && parameters.oldText === "") throw new Error("oldText must not be empty");
			const edits = normalizeEdits(parameters, parameters.path);
			const legacy = parameters.edits === undefined;
			const absolutePath = await resolveAllowedFilePath(parameters.path, allowedRoot);

			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				const originalBytes = await operations.readFile(absolutePath);
				throwIfAborted(signal);
				if (containsNulByte(originalBytes)) throw new Error("Binary files are not supported by edit");
				const hasBom = hasUtf8Bom(originalBytes);
				const originalText = decodeUtf8(originalBytes, parameters.path).replace(/^\uFEFF/, "");
				const ending = detectLineEnding(originalText);
				const baseContent = normalizeLineEndings(originalText);
				const normalizedEdits = edits.map((edit) => ({
					oldText: normalizeLineEndings(edit.oldText),
					newText: normalizeLineEndings(edit.newText),
				}));
				let newContent: string;
				try {
					newContent = applyEditsToContent(baseContent, normalizedEdits, parameters.path).newContent;
				} catch (cause) {
					legacyError(cause, parameters.path, legacy);
				}
				throwIfAborted(signal);
				const currentBytes = await operations.readFile(absolutePath);
				throwIfAborted(signal);
				if (!currentBytes.equals(originalBytes)) {
					throw new Error(`File changed during edit: ${parameters.path}`);
				}
				await operations.writeFile(absolutePath, `${hasBom ? "\uFEFF" : ""}${restoreLineEndings(newContent, ending)}`);
				throwIfAborted(signal);
				const display = generateDiffString(baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: legacy
								? `Successfully replaced text in ${parameters.path}`
								: `Successfully replaced ${normalizedEdits.length} block(s) in ${parameters.path}.`,
						},
					] satisfies ToolResultContent[],
					details: {
						diff: display.diff,
						patch: generateUnifiedPatch(parameters.path, baseContent, newContent),
						...(display.firstChangedLine === undefined ? {} : { firstChangedLine: display.firstChangedLine }),
					},
				};
			});
		},
	};
}
