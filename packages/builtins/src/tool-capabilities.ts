import type { AgentTool, AgentToolResult } from "@di-code/agent";
import type { TSchema } from "@di-code/ai";
import type { SkillCatalog } from "@di-code/skills";
import type { BashOperations } from "./tool-bash-implementation.ts";

/** Workspace-scoped filesystem boundary supplied to built-in file tools. */
export interface WorkspaceCapability {
	readonly allowedRoot: string;
}

/** Process execution boundary supplied to the bash tool. */
export interface ProcessCapability {
	readonly bashOperations?: BashOperations;
}

/** Reserved for tools that need a network client in a later composition stage. */
export interface NetworkCapability {
	readonly available: boolean;
}

export interface ToolPolicyCapability {
	authorize(toolName: string, parameters: unknown, signal?: AbortSignal): void | Promise<void>;
}

export interface ToolApprovalCapability {
	request(toolName: string, parameters: unknown, signal?: AbortSignal): void | Promise<void>;
}

export interface ToolOutputCapability {
	present<TResult extends AgentToolResult>(result: TResult): TResult;
}

export interface ToolCapabilitySnapshot {
	readonly workspace: WorkspaceCapability;
	readonly process: ProcessCapability;
	readonly network: NetworkCapability;
	readonly policy: ToolPolicyCapability;
	readonly approval: ToolApprovalCapability;
	readonly output: ToolOutputCapability;
	readonly skills?: SkillCatalog;
}

export type RuntimeAgentTool = AgentTool<TSchema, AgentToolResult>;

export type ToolFactory = (capabilities: ToolCapabilitySnapshot) => RuntimeAgentTool | undefined;

export function createDefaultToolCapabilities(allowedRoot: string, skills?: SkillCatalog): ToolCapabilitySnapshot {
	return {
		workspace: { allowedRoot },
		process: {},
		network: { available: false },
		policy: { authorize: () => undefined },
		approval: { request: () => undefined },
		output: { present: (result) => result },
		...(skills === undefined ? {} : { skills }),
	};
}
