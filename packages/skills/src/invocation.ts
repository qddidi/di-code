import { readSkillContent } from "./document.ts";
import type { SkillCatalog } from "./types.ts";

export async function resolveSkillInvocation(
	text: string,
	catalog: SkillCatalog,
	signal?: AbortSignal,
): Promise<string> {
	const command = text.trimStart();
	if (!command.startsWith("/skill")) return text;
	const match = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(command);
	if (!match) throw new Error("Skill command must use /skill:<name> [request].");
	const name = match[1] ?? "";
	const skill = catalog.resolve(name);
	if (!skill || !skill.userInvocable) {
		const available = catalog.listForUser().map((candidate) => candidate.name);
		throw new Error(
			`Unknown skill "${name}". ${available.length > 0 ? `Available skills: ${available.join(", ")}.` : "No skills are loaded."}`,
		);
	}
	const request = (match[2] ?? "").trim();
	const args = request.length > 0 ? request.split(/\s+/) : [];
	const replaced = (await readSkillContent(skill, signal))
		.replaceAll("$ARGUMENTS", request)
		.replace(/\$(\d+)/g, (_whole, index: string) => args[Number(index) - 1] ?? "");
	return [
		`<explicit_skill name="${skill.name}" path="${skill.filePath}">`,
		replaced,
		"</explicit_skill>",
		"<skill_request>",
		request || "Follow the explicitly selected skill instructions.",
		"</skill_request>",
	].join("\n");
}
