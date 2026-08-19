import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSkill } from "./document.ts";
import type { SkillLoadResult, SkillSource } from "./types.ts";

function isMissing(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function failed(path: string, message: string): SkillLoadResult {
	return { diagnostics: [{ kind: "skill", path, stage: "discover", severity: "error", message }] };
}

export async function discoverSkills(directory: string, source: SkillSource): Promise<readonly SkillLoadResult[]> {
	const root = resolve(directory);
	const results: SkillLoadResult[] = [];
	try {
		if ((await lstat(root)).isSymbolicLink()) {
			return [failed(root, "Skill discovery root must not be a symbolic link")];
		}
	} catch (cause) {
		if (!isMissing(cause)) return [failed(root, `Failed to inspect Skill directory: ${String(cause)}`)];
		return results;
	}
	async function visit(current: string): Promise<void> {
		let entries: import("node:fs").Dirent<string>[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (cause) {
			if (!isMissing(cause)) results.push(failed(current, `Failed to read Skill directory: ${String(cause)}`));
			return;
		}
		const skillEntry = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
		if (skillEntry) {
			results.push(await loadSkill(join(current, skillEntry.name), source));
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || !entry.isDirectory()) continue;
			const child = join(current, entry.name);
			try {
				if ((await lstat(child)).isDirectory()) await visit(child);
			} catch (cause) {
				if (!isMissing(cause)) results.push(failed(child, `Failed to inspect Skill directory: ${String(cause)}`));
			}
		}
	}
	await visit(root);
	return results;
}
