import { createBuiltinToolSnapshot, createDefaultToolCapabilities } from "@di-code/builtins";
import { createSkillCatalog } from "@di-code/skills";
import {
	type AgentSessionOptions,
	type AgentSessionTool,
	AgentSession as ProductionAgentSession,
} from "../src/core/session.ts";

export type { AgentSessionEvent } from "../src/core/session.ts";

type TestAgentSessionOptions = Omit<AgentSessionOptions, "tools"> & {
	readonly tools?: readonly AgentSessionTool[];
};

function createTestToolSnapshot(options: TestAgentSessionOptions): readonly AgentSessionTool[] {
	if (options.tools !== undefined) return Object.freeze([...options.tools]);
	const catalog = createSkillCatalog(
		(options.skills ?? []).map((skill) => ({
			skill: {
				...skill,
				source:
					skill.source ?? (skill.scope === "explicit" ? "explicit" : skill.scope === "project" ? "project" : "user"),
				userInvocable: skill.userInvocable ?? true,
			},
			diagnostics: [],
		})),
	);
	return createBuiltinToolSnapshot(createDefaultToolCapabilities(options.allowedRoot, catalog));
}

/** Test-only constructor that supplies the same explicit built-in snapshot expected by legacy integration fixtures. */
export class AgentSession extends ProductionAgentSession {
	constructor(options: TestAgentSessionOptions) {
		const { tools, ...sessionOptions } = options;
		super({ ...sessionOptions, tools: createTestToolSnapshot({ ...sessionOptions, ...(tools ? { tools } : {}) }) });
	}
}
