export type SkillSource = "system" | "user" | "project" | "explicit" | "plugin" | "package";

export interface SkillMetadata {
	readonly name: string;
	readonly description: string;
	readonly disableModelInvocation: boolean;
	readonly userInvocable: boolean;
	readonly argumentHint?: string;
}

export interface SkillDescriptor extends SkillMetadata {
	readonly kind: "skill";
	readonly filePath: string;
	readonly baseDir: string;
	readonly source: SkillSource;
}

export type SkillDiagnosticStage = "discover" | "read" | "parse" | "collision" | "trust";

export interface SkillDiagnostic {
	readonly kind: "skill";
	readonly path: string;
	readonly stage: SkillDiagnosticStage;
	readonly severity: "warning" | "error";
	readonly message: string;
}

export interface SkillLoadResult {
	readonly skill?: SkillDescriptor;
	readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SkillCatalog {
	readonly skills: readonly SkillDescriptor[];
	readonly diagnostics: readonly SkillDiagnostic[];
	resolve(name: string): SkillDescriptor | undefined;
	listForModel(): readonly SkillDescriptor[];
	listForUser(): readonly SkillDescriptor[];
}
