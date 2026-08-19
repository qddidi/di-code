import type { SkillDescriptor, SkillSource } from "@di-code/skills";

export type ResourceScope = "global" | "ancestor" | "project" | "explicit";

export type ResourceDiagnosticStage = "discover" | "read" | "parse" | "collision" | "trust";

export interface ResourceDiagnostic {
	readonly path: string;
	readonly kind: "agents" | "skill";
	readonly stage: ResourceDiagnosticStage;
	readonly severity: "warning" | "error";
	readonly message: string;
}

export interface ContextFile {
	readonly kind: "agents";
	readonly path: string;
	readonly scope: ResourceScope;
	readonly content: string;
}

export type SkillResource = Omit<SkillDescriptor, "source" | "userInvocable"> & {
	readonly scope: ResourceScope;
	readonly source?: SkillSource;
	readonly userInvocable?: boolean;
};

export interface ResourceSnapshot {
	readonly contextFiles: readonly ContextFile[];
	readonly skills: readonly SkillResource[];
	readonly diagnostics: readonly ResourceDiagnostic[];
}

export interface ResourceLoaderOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted?: boolean;
	readonly noSkills?: boolean;
	readonly noContextFiles?: boolean;
	readonly skillPaths?: readonly string[];
}

export interface ResourceLoader {
	load(): Promise<ResourceSnapshot>;
}
