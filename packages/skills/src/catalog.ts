import type { SkillCatalog, SkillDescriptor, SkillDiagnostic, SkillLoadResult } from "./types.ts";

export function createSkillCatalog(results: readonly SkillLoadResult[]): SkillCatalog {
	const skills: SkillDescriptor[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const byName = new Map<string, SkillDescriptor>();
	for (const result of results) {
		diagnostics.push(...result.diagnostics);
		const skill = result.skill;
		if (!skill) continue;
		const existing = byName.get(skill.name);
		if (existing) {
			diagnostics.push({
				kind: "skill",
				path: skill.filePath,
				stage: "collision",
				severity: "warning",
				message: `Skill name collision: "${skill.name}"; using ${existing.filePath}`,
			});
			continue;
		}
		byName.set(skill.name, skill);
		skills.push(skill);
	}
	const copy = (items: readonly SkillDescriptor[]): readonly SkillDescriptor[] => items.map((item) => ({ ...item }));
	return {
		get skills() {
			return copy(skills);
		},
		get diagnostics() {
			return diagnostics.map((item) => ({ ...item }));
		},
		resolve(name) {
			const skill = byName.get(name);
			return skill ? { ...skill } : undefined;
		},
		listForModel() {
			return copy(skills.filter((skill) => !skill.disableModelInvocation));
		},
		listForUser() {
			return copy(skills.filter((skill) => skill.userInvocable));
		},
	};
}
