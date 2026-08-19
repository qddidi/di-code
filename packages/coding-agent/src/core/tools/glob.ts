import { matchesGlob } from "node:path";
import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import {
	appendBoundedLine,
	assertSearchLimit,
	DEFAULT_SEARCH_MAX_OUTPUT_BYTES,
	DEFAULT_SEARCH_MAX_RESULTS,
	normalizeSearchPattern,
	resolveSearchRoot,
	walkSearchFiles,
} from "./file-search.ts";

export const globParameters = Type.Object({
	pattern: Type.String({ minLength: 1 }),
	path: Type.Optional(Type.String({ minLength: 1 })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type GlobParameters = Static<typeof globParameters>;
export type GlobTool = AgentTool<typeof globParameters, ToolResultContent[]>;

export function createGlobTool(allowedRoot: string): GlobTool {
	return {
		name: "glob",
		description:
			"Find files inside the allowed root using a glob pattern such as **/*.ts. Returns sorted relative paths; symlinks are skipped.",
		parameters: globParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (parameters.path !== undefined && parameters.path.length === 0) throw new Error("path must not be empty");
			const pattern = normalizeSearchPattern(parameters.pattern);
			const maxResults = parameters.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
			assertSearchLimit("maxResults", maxResults);
			const root = await resolveSearchRoot(parameters.path, allowedRoot);
			const displayRoot = await resolveSearchRoot(undefined, allowedRoot);
			const lines: string[] = [];
			let matched = 0;
			let truncated = false;
			for await (const file of walkSearchFiles(root, signal, displayRoot)) {
				if (!matchesGlob(file.searchPath, pattern)) continue;
				matched++;
				if (matched > maxResults || !appendBoundedLine(lines, file.relativePath, DEFAULT_SEARCH_MAX_OUTPUT_BYTES)) {
					truncated = true;
					break;
				}
			}
			if (lines.length === 0) return [{ type: "text", text: "No files matched." }];
			if (truncated) lines.push(`[Results truncated at ${maxResults} matches or 50 KiB.]`);
			return [{ type: "text", text: lines.join("\n") }];
		},
	};
}
