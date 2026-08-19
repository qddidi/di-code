import { parseDocument } from "yaml";
import type { SkillDiagnostic, SkillMetadata } from "./types.ts";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface ParsedSkillDocument {
	readonly metadata: SkillMetadata;
	readonly body: string;
}

function diagnostic(path: string, message: string): SkillDiagnostic {
	return { kind: "skill", path, stage: "parse", severity: "warning", message };
}

function splitFrontmatter(source: string): { header: string; body: string } | undefined {
	const normalized = source.replace(/^\uFEFF/, "");
	const lines = normalized.split(/\r?\n/);
	if (lines[0] !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && line === "---");
	if (end < 0) return undefined;
	return { header: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function scalarString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function parseSkillDocument(
	source: string,
	path: string,
): { document?: ParsedSkillDocument; diagnostics: readonly SkillDiagnostic[] } {
	const parts = splitFrontmatter(source);
	if (!parts)
		return { diagnostics: [diagnostic(path, "Skill frontmatter must start with --- and have a closing ---")] };
	const document = parseDocument(parts.header, { version: "1.2", uniqueKeys: true });
	if (document.errors.length > 0) {
		return {
			diagnostics: document.errors.map((error) => diagnostic(path, `Invalid Skill frontmatter: ${error.message}`)),
		};
	}
	const parsedValue: unknown = document.toJSON();
	if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
		return { diagnostics: [diagnostic(path, "Skill frontmatter must be a YAML mapping")] };
	}
	const values = new Map(Object.entries(parsedValue as Record<string, unknown>));
	const name = scalarString(values.get("name"));
	const description = scalarString(values.get("description"));
	const diagnostics: SkillDiagnostic[] = [];
	if (!name) diagnostics.push(diagnostic(path, "name is required"));
	else if (name.length === 0 || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
		diagnostics.push(
			diagnostic(path, "name must contain only lowercase letters, numbers, and single hyphens (maximum 64 characters)"),
		);
	}
	if (!description) diagnostics.push(diagnostic(path, "description is required"));
	else if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
		diagnostics.push(diagnostic(path, "description must be between 1 and 1024 characters"));
	}
	const booleanFields = ["disable-model-invocation", "user-invocable"] as const;
	for (const field of booleanFields) {
		const value = values.get(field);
		if (value !== undefined && typeof value !== "boolean")
			diagnostics.push(diagnostic(path, `${field} must be a YAML boolean`));
	}
	const argumentHint = values.get("argument-hint");
	if (argumentHint !== undefined && typeof argumentHint !== "string")
		diagnostics.push(diagnostic(path, "argument-hint must be a string"));
	for (const key of values.keys()) {
		if (!["name", "description", ...booleanFields, "argument-hint"].includes(key))
			diagnostics.push({ ...diagnostic(path, `Unknown Skill metadata field "${key}"`), severity: "warning" });
	}
	if (diagnostics.length > 0) return { diagnostics };
	return {
		document: {
			metadata: {
				name: name as string,
				description: description as string,
				disableModelInvocation: (values.get("disable-model-invocation") as boolean | undefined) ?? false,
				userInvocable: (values.get("user-invocable") as boolean | undefined) ?? true,
				...(argumentHint === undefined ? {} : { argumentHint: argumentHint as string }),
			},
			body: parts.body,
		},
		diagnostics,
	};
}
