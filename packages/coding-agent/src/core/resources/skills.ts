import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResourceDiagnostic, ResourceScope, SkillResource } from "./types.ts";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

interface ParsedSkill {
	readonly skill?: SkillResource;
	readonly diagnostics: readonly ResourceDiagnostic[];
}

function diagnostic(
	path: string,
	stage: ResourceDiagnostic["stage"],
	message: string,
	severity: ResourceDiagnostic["severity"] = "warning",
): ResourceDiagnostic {
	return { path, kind: "skill", stage, severity, message };
}

function parseScalar(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseFrontmatter(source: string): Record<string, string> | undefined {
	const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0] !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && line === "---");
	if (end < 0) return undefined;
	const entries: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		entries[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
	}
	return entries;
}

function extractSkillBody(source: string): string | undefined {
	const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0] !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && line === "---");
	if (end < 0) return undefined;
	return lines.slice(end + 1).join("\n");
}

function validateName(name: string): string | undefined {
	if (name.length === 0) return "name is required";
	if (name.length > MAX_NAME_LENGTH) return `name exceeds ${MAX_NAME_LENGTH} characters`;
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		return "name must contain only lowercase letters, numbers, and single hyphens";
	}
	return undefined;
}

function validateDescription(description: string): string | undefined {
	if (description.length === 0) return "description is required";
	if (description.length > MAX_DESCRIPTION_LENGTH) return `description exceeds ${MAX_DESCRIPTION_LENGTH} characters`;
	return undefined;
}

export async function loadSkill(path: string, scope: ResourceScope): Promise<ParsedSkill> {
	const filePath = resolve(path);
	const diagnostics: ResourceDiagnostic[] = [];
	try {
		const metadata = await stat(filePath);
		if (!metadata.isFile()) return { diagnostics: [diagnostic(filePath, "discover", "Skill path is not a file")] };
		if (metadata.size > MAX_SKILL_BYTES) {
			return { diagnostics: [diagnostic(filePath, "read", `Skill exceeds ${MAX_SKILL_BYTES} byte limit`)] };
		}
		const source = await readFile(filePath, "utf8");
		const frontmatter = parseFrontmatter(source);
		if (!frontmatter) return { diagnostics: [diagnostic(filePath, "parse", "Skill frontmatter is required")] };
		const name = frontmatter.name ?? "";
		const description = frontmatter.description ?? "";
		const nameError = validateName(name);
		const descriptionError = validateDescription(description);
		if (nameError) diagnostics.push(diagnostic(filePath, "parse", nameError));
		if (descriptionError) diagnostics.push(diagnostic(filePath, "parse", descriptionError));
		if (nameError || descriptionError) return { diagnostics };
		const disableModelInvocationValue = frontmatter["disable-model-invocation"];
		if (
			disableModelInvocationValue !== undefined &&
			disableModelInvocationValue !== "true" &&
			disableModelInvocationValue !== "false"
		) {
			return {
				diagnostics: [diagnostic(filePath, "parse", "disable-model-invocation must be true or false")],
			};
		}
		return {
			skill: {
				kind: "skill",
				name,
				description,
				filePath,
				baseDir: dirname(filePath),
				scope,
				disableModelInvocation: disableModelInvocationValue === "true",
			},
			diagnostics,
		};
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return { diagnostics: [diagnostic(filePath, "read", `Failed to read skill: ${message}`, "error")] };
	}
}

export async function readSkillContent(skill: SkillResource, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const path = resolve(skill.filePath);
	try {
		const metadata = await stat(path);
		if (!metadata.isFile()) throw new Error("Skill path is not a file");
		if (metadata.size > MAX_SKILL_BYTES) throw new Error(`Skill exceeds ${MAX_SKILL_BYTES} byte limit`);
		const source = await readFile(path, { encoding: "utf8", signal });
		const body = extractSkillBody(source);
		if (body === undefined) throw new Error("Skill frontmatter is required");
		return body;
	} catch (cause) {
		if (cause instanceof Error && cause.message === "Operation aborted") throw cause;
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to load skill "${skill.name}": ${message}`, { cause });
	}
}

export async function discoverSkills(directory: string, scope: ResourceScope): Promise<ParsedSkill[]> {
	const root = resolve(directory);
	const results: ParsedSkill[] = [];
	async function visit(current: string): Promise<void> {
		let entries: import("node:fs").Dirent<string>[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (cause) {
			if (isMissingPath(cause)) return;
			const message = cause instanceof Error ? cause.message : String(cause);
			results.push({
				diagnostics: [diagnostic(current, "discover", `Failed to read skill directory: ${message}`, "error")],
			});
			return;
		}
		const skillEntry = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
		if (skillEntry) {
			results.push(await loadSkill(join(current, skillEntry.name), scope));
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || !entry.isDirectory()) continue;
			await visit(join(current, entry.name));
		}
	}
	await visit(root);
	return results;
}

function isMissingPath(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
