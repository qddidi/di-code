import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSkillCatalog, discoverSkills, loadSkill, type SkillLoadResult } from "@di-code/skills";
import type {
	ContextFile,
	ResourceDiagnostic,
	ResourceLoader,
	ResourceLoaderOptions,
	ResourceScope,
	ResourceSnapshot,
	SkillResource,
} from "./types.ts";

const MAX_CONTEXT_FILE_BYTES = 256 * 1024;

function isMissingPath(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function contextDiagnostic(path: string, stage: ResourceDiagnostic["stage"], message: string): ResourceDiagnostic {
	return { path, kind: "agents", stage, severity: "warning", message };
}

async function locateAgentsFile(directory: string): Promise<string | undefined> {
	for (const name of ["AGENTS.md", "AGENTS.MD"]) {
		const path = join(directory, name);
		try {
			if ((await stat(path)).isFile()) return path;
		} catch (cause) {
			if (!isMissingPath(cause)) throw cause;
		}
	}
	return undefined;
}

async function loadContextFile(
	path: string,
	scope: ResourceScope,
): Promise<{ file?: ContextFile; diagnostic?: ResourceDiagnostic }> {
	try {
		const metadata = await stat(path);
		if (metadata.size > MAX_CONTEXT_FILE_BYTES) {
			return { diagnostic: contextDiagnostic(path, "read", `AGENTS.md exceeds ${MAX_CONTEXT_FILE_BYTES} byte limit`) };
		}
		return { file: { kind: "agents", path: resolve(path), scope, content: await readFile(path, "utf8") } };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return { diagnostic: contextDiagnostic(path, "read", `Failed to read AGENTS.md: ${message}`) };
	}
}

async function loadContextFiles(options: ResourceLoaderOptions): Promise<{
	contextFiles: ContextFile[];
	diagnostics: ResourceDiagnostic[];
}> {
	if (options.noContextFiles) return { contextFiles: [], diagnostics: [] };
	const contextFiles: ContextFile[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const seen = new Set<string>();
	const add = async (directory: string, scope: ResourceScope): Promise<void> => {
		let path: string | undefined;
		try {
			path = await locateAgentsFile(directory);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			diagnostics.push(contextDiagnostic(directory, "discover", `Failed to discover AGENTS.md: ${message}`));
			return;
		}
		if (!path) return;
		const absolutePath = resolve(path);
		if (seen.has(absolutePath)) return;
		seen.add(absolutePath);
		const loaded = await loadContextFile(absolutePath, scope);
		if (loaded.file) contextFiles.push(loaded.file);
		if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
	};

	await add(resolve(options.agentDir), "global");
	await add(resolve(options.cwd), "project");
	return { contextFiles, diagnostics };
}

async function exists(directory: string): Promise<boolean> {
	try {
		await access(directory);
		return true;
	} catch (cause) {
		if (isMissingPath(cause)) return false;
		throw cause;
	}
}

export class DefaultResourceLoader implements ResourceLoader {
	private readonly options: ResourceLoaderOptions;

	constructor(options: ResourceLoaderOptions) {
		this.options = options;
	}

	async load(): Promise<ResourceSnapshot> {
		const context = await loadContextFiles(this.options);
		const diagnostics = [...context.diagnostics];
		const skillResults: SkillLoadResult[] = [];
		const addResults = (results: readonly SkillLoadResult[]): void => {
			skillResults.push(...results);
		};

		if (!this.options.noSkills) {
			for (const rawPath of this.options.skillPaths ?? []) {
				const path = resolve(this.options.cwd, rawPath);
				try {
					const metadata = await stat(path);
					if (metadata.isDirectory()) addResults(await discoverSkills(path, "explicit"));
					else {
						const result = await loadSkill(path, "explicit");
						skillResults.push(result);
					}
				} catch (cause) {
					const message = isMissingPath(cause)
						? "Skill path does not exist"
						: `Failed to discover skill path: ${String(cause)}`;
					diagnostics.push({ path, kind: "skill", stage: "discover", severity: "warning", message });
				}
			}
			const projectDirectories = [
				join(this.options.cwd, ".di-code", "skills"),
				join(this.options.cwd, ".agents", "skills"),
			];
			if (this.options.projectTrusted === true) {
				for (const directory of projectDirectories) addResults(await discoverSkills(directory, "project"));
			} else {
				for (const directory of projectDirectories) {
					if (await exists(directory)) {
						diagnostics.push({
							path: resolve(directory),
							kind: "skill",
							stage: "trust",
							severity: "warning",
							message: "Project skill skipped because project trust is not granted",
						});
					}
				}
			}
			addResults(await discoverSkills(join(this.options.agentDir, "skills"), "user"));
		}
		const catalog = createSkillCatalog(skillResults);
		const skillDiagnostics = catalog.diagnostics.map((diagnostic): ResourceDiagnostic => diagnostic);
		const skills: SkillResource[] = catalog.skills.map((skill) => ({
			...skill,
			scope: skill.source === "explicit" ? "explicit" : skill.source === "project" ? "project" : "global",
		}));
		return { contextFiles: context.contextFiles, skills, diagnostics: [...diagnostics, ...skillDiagnostics] };
	}
}

export async function loadResources(options: ResourceLoaderOptions): Promise<ResourceSnapshot> {
	return new DefaultResourceLoader(options).load();
}
