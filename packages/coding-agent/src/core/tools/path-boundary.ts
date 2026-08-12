import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function assertInsideRoot(root: string, target: string): void {
	const fromRoot = relative(root, target);
	if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
		return;
	}
	throw new Error("Path is outside the allowed root");
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

export async function resolveAllowedMutationPath(inputPath: string, allowedRoot: string): Promise<string> {
	const rootReal = await realpath(allowedRoot);
	const candidate = resolve(rootReal, inputPath);
	assertInsideRoot(rootReal, candidate);

	const missingSegments: string[] = [];
	let current = candidate;

	while (true) {
		try {
			const currentReal = await realpath(current);
			assertInsideRoot(rootReal, currentReal);
			const target = resolve(currentReal, ...missingSegments.reverse());
			assertInsideRoot(rootReal, target);
			return target;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			let entryExists = false;
			try {
				const entry = await lstat(current);
				if (entry.isSymbolicLink()) throw new Error("Path is outside the allowed root");
				entryExists = true;
			} catch (entryError) {
				if (!isMissingPathError(entryError)) throw entryError;
			}
			if (entryExists) continue;
			const parent = dirname(current);
			if (parent === current) throw error;
			missingSegments.push(basename(current));
			current = parent;
		}
	}
}

export async function resolveAllowedFilePath(inputPath: string, allowedRoot: string): Promise<string> {
	const rootReal = await realpath(allowedRoot);
	const candidate = resolve(rootReal, inputPath);
	assertInsideRoot(rootReal, candidate);
	const targetReal = await realpath(candidate);
	assertInsideRoot(rootReal, targetReal);
	return targetReal;
}
