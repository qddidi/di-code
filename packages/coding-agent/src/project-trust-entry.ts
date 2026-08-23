import { join } from "node:path";
import { ProjectTrustStore } from "@di-code/plugin-loader";
import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";

export interface ProjectTrustService {
	readonly store: ProjectTrustStore;
}

export interface ProjectTrustConfig {
	readonly filePath: string;
}

export const apiVersion = 1 as const;
export const name = "project-trust";
export const version = "0.1.7";
export const projectTrustKey = createServiceKey<ProjectTrustService>("project-trust");
export function createProjectTrustStore(filePath: string): ProjectTrustStore {
	return new ProjectTrustStore(filePath);
}
export const apply: PluginDefinition<ProjectTrustConfig>["apply"] = (context, config) => {
	const filePath = config?.filePath ?? join(process.cwd(), ".di-code", "trust.json");
	context.set(projectTrustKey, { store: new ProjectTrustStore(filePath) });
};
