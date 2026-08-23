import {
	agentSessionKey,
	networkCapabilityKey,
	processCapabilityKey,
	toolApprovalKey,
	toolOutputKey,
	toolPolicyKey,
	toolRegistryKey,
	workspaceCapabilityKey,
} from "@di-code/builtins";
import { type Context, createServiceKey, type Disposer } from "@di-code/plugin-runtime";
import { createSkillCatalog } from "@di-code/skills";
import type { SkillResource } from "../core/resources/types.ts";
import { AgentSession, type AgentSessionOptions, type AgentSessionTool } from "../core/session.ts";

export interface CompositionSessionOptions extends Omit<AgentSessionOptions, "tools" | "skills"> {
	readonly skills?: readonly SkillResource[];
	/** MCP tools already adapted by the product integration layer. */
	readonly externalTools?: readonly AgentSessionTool[];
}

interface SessionDependencies {
	readonly tools: readonly AgentSessionTool[];
}

const sessionDependenciesKey = createServiceKey<SessionDependencies>("session-dependencies");

function asCompositionSessionOptions(value: unknown): CompositionSessionOptions {
	if (typeof value !== "object" || value === null) throw new TypeError("AgentSessionFactory options must be an object");
	return value as CompositionSessionOptions;
}

/**
 * Installs the product AgentSession implementation behind the composition factory.
 * Each session receives an isolated Context and immutable tool snapshot; the factory disposer releases all scopes.
 */
export function installAgentSessionFactory(context: Context): Disposer {
	const factory = context.require(agentSessionKey);
	const sessionContexts = new Set<Context>();
	let nextSessionId = 0;

	const unregister = factory.register((input) => {
		const options = asCompositionSessionOptions(input);
		const workspace = context.require(workspaceCapabilityKey);
		if (options.allowedRoot !== workspace.allowedRoot) {
			throw new Error("AgentSession allowedRoot must match the composition workspace capability.");
		}
		const skillCatalog = createSkillCatalog(
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
		const tools = Object.freeze([
			...context.require(toolRegistryKey).snapshot({
				workspace,
				process: context.require(processCapabilityKey),
				network: context.require(networkCapabilityKey),
				policy: context.require(toolPolicyKey),
				approval: context.require(toolApprovalKey),
				output: context.require(toolOutputKey),
				skills: skillCatalog,
			}),
			...(options.externalTools ?? []),
		]);
		const sessionContext = context.child({ id: `session-${++nextSessionId}`, isolate: true });
		sessionContexts.add(sessionContext);
		sessionContext.set(sessionDependenciesKey, {
			tools,
		});
		return new AgentSession({
			...options,
			tools: sessionContext.require(sessionDependenciesKey).tools,
		});
	});
	return async () => {
		unregister();
		for (const sessionContext of [...sessionContexts].reverse()) await sessionContext.dispose();
		sessionContexts.clear();
	};
}
