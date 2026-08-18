import { access, constants, readFile } from "node:fs/promises";
import * as Diff from "diff";
import { resolveAllowedFilePath } from "./path-boundary.ts";

export interface Edit {
	readonly oldText: string;
	readonly newText: string;
}

export interface EditDiffResult {
	readonly diff: string;
	readonly patch: string;
	readonly firstChangedLine?: number;
}

export interface EditDiffError {
	readonly error: string;
}

interface MatchedEdit extends Edit {
	readonly matchIndex: number;
	readonly matchLength: number;
}

function normalizeToLF(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function findMatches(content: string, search: string): number[] {
	const matches: number[] = [];
	let offset = 0;
	while (offset <= content.length - search.length) {
		const index = content.indexOf(search, offset);
		if (index < 0) break;
		matches.push(index);
		offset = index + 1;
	}
	return matches;
}

function matchEdits(content: string, edits: readonly Edit[], path: string): MatchedEdit[] {
	const matches = edits.map((edit, index) => {
		if (edit.oldText.length === 0) throw new Error(`oldText must not be empty in ${path}`);
		const indexes = findMatches(content, edit.oldText);
		if (indexes.length === 0) {
			throw new Error(`Could not find edits[${index}] in ${path}. The oldText must match exactly.`);
		}
		if (indexes.length > 1) {
			throw new Error(
				`Found ${indexes.length} occurrences of edits[${index}] in ${path}. Each oldText must be unique.`,
			);
		}
		return { ...edit, matchIndex: indexes[0], matchLength: edit.oldText.length };
	});

	const ordered = [...matches].sort((left, right) => left.matchIndex - right.matchIndex);
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (current.matchIndex < previous.matchIndex + previous.matchLength) {
			throw new Error(`Edits overlap in ${path}. Merge overlapping regions into one edit.`);
		}
	}
	return matches;
}

export function applyEditsToContent(
	content: string,
	edits: readonly Edit[],
	path: string,
): { baseContent: string; newContent: string } {
	if (edits.length === 0) throw new Error(`At least one edit is required for ${path}`);
	const matched = matchEdits(content, edits, path).sort((left, right) => right.matchIndex - left.matchIndex);
	let result = content;
	for (const edit of matched) {
		result = `${result.slice(0, edit.matchIndex)}${edit.newText}${result.slice(edit.matchIndex + edit.matchLength)}`;
	}
	return { baseContent: content, newContent: result };
}

/** Generate a standard unified patch for storage/export. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/** Generate the line-numbered display diff consumed by the interactive renderer. */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent, { newlineIsToken: false });
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	const output: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	let firstChangedLine: number | undefined;
	let changedSeen = false;
	for (let partIndex = 0; partIndex < parts.length; partIndex++) {
		const part = parts[partIndex];
		const lines = part.value.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (part.removed) {
			if (firstChangedLine === undefined && lines.length > 0) firstChangedLine = newLine;
			for (const line of lines) {
				output.push(`-${String(oldLine).padStart(lineNumWidth, " ")} ${line}`);
				oldLine += 1;
			}
			changedSeen = true;
			continue;
		}
		if (part.added) {
			if (firstChangedLine === undefined && lines.length > 0) firstChangedLine = newLine;
			for (const line of lines) {
				output.push(`+${String(newLine).padStart(lineNumWidth, " ")} ${line}`);
				newLine += 1;
			}
			changedSeen = true;
			continue;
		}

		const changedLater = parts.slice(partIndex + 1).some((candidate) => candidate.added || candidate.removed);
		const visibleIndexes =
			!changedSeen && !changedLater
				? lines.map((_line, index) => index)
				: !changedSeen && changedLater
					? lines.map((_line, index) => index).slice(-contextLines)
					: changedSeen && changedLater
						? lines.length <= contextLines * 2
							? lines.map((_line, index) => index)
							: [
									...lines.map((_line, index) => index).slice(0, contextLines),
									...lines.map((_line, index) => index).slice(-contextLines),
								]
						: lines.map((_line, index) => index).slice(0, contextLines);
		for (const lineIndex of visibleIndexes) {
			output.push(` ${String(newLine + lineIndex).padStart(lineNumWidth, " ")} ${lines[lineIndex]}`);
		}
		oldLine += lines.length;
		newLine += lines.length;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export async function computeEditsDiff(
	path: string,
	edits: readonly Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	try {
		const absolutePath = await resolveAllowedFilePath(path, cwd);
		await access(absolutePath, constants.R_OK);
		const rawContent = stripBom(await readFile(absolutePath, "utf8"));
		const baseContent = normalizeToLF(rawContent);
		const applied = applyEditsToContent(
			baseContent,
			edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) })),
			path,
		);
		const display = generateDiffString(applied.baseContent, applied.newContent);
		return {
			...display,
			patch: generateUnifiedPatch(path, applied.baseContent, applied.newContent),
		};
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
}
