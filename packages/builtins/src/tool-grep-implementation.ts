import { matchesGlob } from "node:path";
import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import {
	appendBoundedLine,
	assertSearchLimit,
	DEFAULT_SEARCH_MAX_OUTPUT_BYTES,
	DEFAULT_SEARCH_MAX_RESULTS,
	normalizeSearchPattern,
	readSearchText,
	resolveSearchRoot,
	walkSearchFiles,
} from "./file-search.ts";

export const grepParameters = Type.Object({
	pattern: Type.String({ minLength: 1, maxLength: 1_000 }),
	path: Type.Optional(Type.String({ minLength: 1 })),
	include: Type.Optional(Type.String({ minLength: 1 })),
	caseSensitive: Type.Optional(Type.Boolean()),
	maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type GrepParameters = Static<typeof grepParameters>;
export type GrepTool = AgentTool<typeof grepParameters, ToolResultContent[]>;

export function createGrepTool(allowedRoot: string): GrepTool {
	return {
		name: "grep",
		description:
			"Search UTF-8 text files inside the allowed root for a literal string. Returns sorted path:line matches; binary files and symlinks are skipped.",
		parameters: grepParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (parameters.pattern.length === 0) throw new Error("pattern must not be empty");
			if (parameters.pattern.length > 1_000) throw new Error("pattern must not exceed 1000 characters");
			if (parameters.path !== undefined && parameters.path.length === 0) throw new Error("path must not be empty");
			const include = parameters.include === undefined ? undefined : normalizeSearchPattern(parameters.include);
			const maxResults = parameters.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
			assertSearchLimit("maxResults", maxResults);
			const root = await resolveSearchRoot(parameters.path, allowedRoot);
			const displayRoot = await resolveSearchRoot(undefined, allowedRoot);
			const needle = parameters.caseSensitive === false ? parameters.pattern.toLocaleLowerCase() : parameters.pattern;
			const lines: string[] = [];
			let matched = 0;
			let truncated = false;
			for await (const file of walkSearchFiles(root, signal, displayRoot)) {
				if (include !== undefined && !matchesInclude(file.searchPath, include)) continue;
				const text = await readSearchText(file, allowedRoot, signal);
				if (text === undefined) continue;
				const fileLines = text.split("\n");
				for (let index = 0; index < fileLines.length; index++) {
					const line = fileLines[index] ?? "";
					const haystack = parameters.caseSensitive === false ? line.toLocaleLowerCase() : line;
					if (!haystack.includes(needle)) continue;
					matched++;
					if (
						matched > maxResults ||
						!appendBoundedLine(lines, `${file.relativePath}:${index + 1}: ${line}`, DEFAULT_SEARCH_MAX_OUTPUT_BYTES)
					) {
						truncated = true;
						break;
					}
				}
				if (truncated) break;
			}
			if (lines.length === 0) return [{ type: "text", text: "No matches found." }];
			if (truncated) lines.push(`[Results truncated at ${maxResults} matches or 50 KiB.]`);
			return [{ type: "text", text: lines.join("\n") }];
		},
	};
}

function matchesInclude(relativePath: string, pattern: string): boolean {
	return matchesGlob(relativePath, pattern);
}
