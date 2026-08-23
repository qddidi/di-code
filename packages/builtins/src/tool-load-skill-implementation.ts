import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import type { SkillCatalog } from "@di-code/skills";
import { readSkillContent } from "@di-code/skills";

export const loadSkillParameters = Type.Object({
	name: Type.String({ minLength: 1 }),
});

export type LoadSkillParameters = Static<typeof loadSkillParameters>;
export type LoadSkillTool = AgentTool<typeof loadSkillParameters, ToolResultContent[]>;

export function createLoadSkillTool(catalog: SkillCatalog): LoadSkillTool {
	return {
		name: "load_skill",
		description: "Load the untrusted instructions for a registered skill by name.",
		parameters: loadSkillParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			if (signal?.aborted) throw new Error("Operation aborted");
			const skill = catalog.resolve(parameters.name);
			if (!skill || skill.disableModelInvocation) throw new Error(`Unknown or unavailable skill "${parameters.name}".`);
			const content = await readSkillContent(skill, signal);
			return [{ type: "text", text: `<skill name="${skill.name}" source="${skill.source}">\n${content}\n</skill>` }];
		},
	};
}
