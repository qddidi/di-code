import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveAllowedMutationPath } from "./path-boundary.ts";

export const writeParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	content: Type.String(),
});

export type WriteParameters = Static<typeof writeParameters>;

export interface WriteOperations {
	mkdir(directory: string): Promise<void>;
	writeFile(filePath: string, content: string): Promise<void>;
}

export interface WriteToolOptions {
	readonly operations?: WriteOperations;
}

export type WriteTool = AgentTool<typeof writeParameters, ToolResultContent[]>;

const defaultWriteOperations: WriteOperations = {
	async mkdir(directory) {
		await fsMkdir(directory, { recursive: true });
	},
	async writeFile(filePath, content) {
		await fsWriteFile(filePath, content, "utf8");
	},
};

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export function createWriteTool(allowedRoot: string, options: WriteToolOptions = {}): WriteTool {
	const operations = options.operations ?? defaultWriteOperations;

	return {
		name: "write",
		description: "Create or completely overwrite a UTF-8 text file inside the allowed root.",
		parameters: writeParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			throwIfAborted(signal);
			if (parameters.path.length === 0) throw new Error("path must not be empty");
			const absolutePath = await resolveAllowedMutationPath(parameters.path, allowedRoot);

			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				await operations.mkdir(dirname(absolutePath));
				throwIfAborted(signal);
				await operations.writeFile(absolutePath, parameters.content);
				throwIfAborted(signal);

				const bytes = Buffer.byteLength(parameters.content, "utf8");
				return [{ type: "text", text: `Successfully wrote ${bytes} bytes to ${parameters.path}` }];
			});
		},
	};
}
