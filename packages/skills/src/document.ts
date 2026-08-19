import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseSkillDocument } from "./frontmatter.ts";
import type { SkillDescriptor, SkillDiagnostic, SkillLoadResult, SkillSource } from "./types.ts";

export const MAX_SKILL_BYTES = 256 * 1024;

function diagnostic(
	path: string,
	stage: SkillDiagnostic["stage"],
	message: string,
	severity: SkillDiagnostic["severity"] = "warning",
): SkillDiagnostic {
	return { kind: "skill", path, stage, severity, message };
}

async function readBounded(path: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
	const handle = await open(path, "r");
	try {
		const buffer = new Uint8Array(MAX_SKILL_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
		if (bytesRead > MAX_SKILL_BYTES) throw new Error(`Skill exceeds ${MAX_SKILL_BYTES} byte limit`);
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

export async function loadSkill(path: string, source: SkillSource): Promise<SkillLoadResult> {
	const filePath = resolve(path);
	try {
		const metadata = await stat(filePath);
		if (!metadata.isFile()) return { diagnostics: [diagnostic(filePath, "discover", "Skill path is not a file")] };
		const sourceText = await readBounded(filePath);
		const parsed = parseSkillDocument(sourceText, filePath);
		if (!parsed.document) return { diagnostics: parsed.diagnostics };
		const skill: SkillDescriptor = {
			kind: "skill",
			...parsed.document.metadata,
			filePath,
			baseDir: dirname(filePath),
			source,
		};
		return { skill, diagnostics: parsed.diagnostics };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return { diagnostics: [diagnostic(filePath, "read", `Failed to read Skill: ${message}`, "error")] };
	}
}

export async function readSkillContent(skill: SkillDescriptor, signal?: AbortSignal): Promise<string> {
	try {
		const source = await readBounded(resolve(skill.filePath), signal);
		const parsed = parseSkillDocument(source, skill.filePath);
		const error = parsed.diagnostics.find((entry) => entry.severity === "error") ?? parsed.diagnostics[0];
		if (!parsed.document) throw new Error(error?.message ?? "Skill frontmatter is invalid");
		return parsed.document.body;
	} catch (cause) {
		if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
		if (cause instanceof Error && cause.name === "AbortError") throw cause;
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to load skill "${skill.name}": ${message}`, { cause });
	}
}
