import { readSkillContent } from "./resources/skills.ts";
import type { SkillResource } from "./resources/types.ts";

interface SkillInvocation {
	readonly name: string;
	readonly request: string;
}

function parseSkillInvocation(text: string): SkillInvocation | undefined {
	const command = text.trimStart();
	if (!command.startsWith("/skill")) return undefined;
	const match = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(command);
	if (!match) throw new Error("Skill command must use /skill:<name> [request].");
	return { name: match[1] ?? "", request: match[2]?.trim() ?? "" };
}

function formatAvailableSkillNames(skills: readonly SkillResource[]): string {
	return skills.length === 0
		? "No skills are loaded."
		: `Available skills: ${skills.map((skill) => skill.name).join(", ")}.`;
}

export async function resolveSkillCommand(
	text: string,
	skills: readonly SkillResource[],
	signal?: AbortSignal,
): Promise<string> {
	const invocation = parseSkillInvocation(text);
	if (!invocation) return text;
	const skill = skills.find((candidate) => candidate.name === invocation.name);
	if (!skill) throw new Error(`Unknown skill "${invocation.name}". ${formatAvailableSkillNames(skills)}`);
	const content = await readSkillContent(skill, signal);
	const request = invocation.request || "Follow the explicitly selected skill instructions.";
	return [
		`<explicit_skill name="${skill.name}" path="${skill.filePath}">`,
		content,
		"</explicit_skill>",
		"<skill_request>",
		request,
		"</skill_request>",
	].join("\n");
}
