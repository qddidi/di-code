import { createBuiltinToolSnapshot, createDefaultToolCapabilities } from "@di-code/builtins";
import { createSkillCatalog } from "@di-code/skills";
import type { SkillResource } from "./resources/types.ts";
import type { AgentSessionTool } from "./session.ts";

/** Compatibility resolver for direct AgentSession consumers; production uses SessionFactory snapshots. */
export function resolveSessionTools(
	allowedRoot: string,
	skills: readonly SkillResource[],
	tools: readonly AgentSessionTool[] | undefined,
): readonly AgentSessionTool[] {
	if (tools !== undefined) return Object.freeze([...tools]);
	const catalog = createSkillCatalog(
		skills.map((skill) => ({
			skill: {
				...skill,
				source:
					skill.source ?? (skill.scope === "explicit" ? "explicit" : skill.scope === "project" ? "project" : "user"),
				userInvocable: skill.userInvocable ?? true,
			},
			diagnostics: [],
		})),
	);
	return createBuiltinToolSnapshot(createDefaultToolCapabilities(allowedRoot, catalog));
}
