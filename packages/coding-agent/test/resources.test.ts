import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, buildSystemPrompt, loadResources } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "di-code-resources-"));
	roots.push(root);
	return root;
}

async function writeSkill(
	directory: string,
	name: string,
	description: string,
	body = "Follow the skill.",
): Promise<string> {
	const skillDirectory = join(directory, name);
	const path = join(skillDirectory, "SKILL.md");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, "utf8");
	return path;
}

describe("resource discovery", () => {
	it("loads AGENTS files from global through the current directory", async () => {
		const root = await temporaryRoot();
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const nested = join(project, "packages", "app");
		await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(nested, { recursive: true })]);
		await writeFile(join(agentDir, "AGENTS.md"), "global", "utf8");
		await writeFile(join(project, "AGENTS.md"), "project", "utf8");
		await writeFile(join(nested, "AGENTS.md"), "nested", "utf8");

		const resources = await loadResources({ cwd: nested, agentDir, noSkills: true });

		expect(resources.contextFiles.map((file) => file.content)).toEqual(["global", "project", "nested"]);
	});

	it("prefers explicit skills and omits their bodies from the prompt inventory", async () => {
		const root = await temporaryRoot();
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const globalPath = await writeSkill(join(agentDir, "skills"), "review", "global review", "global body");
		const projectPath = await writeSkill(
			join(project, ".di-code", "skills"),
			"review",
			"project review",
			"project body",
		);
		const explicitPath = await writeSkill(join(root, "explicit"), "review", "explicit review", "explicit body");

		const resources = await loadResources({
			cwd: project,
			agentDir,
			projectTrusted: true,
			skillPaths: [explicitPath],
		});
		const prompt = buildSystemPrompt({ cwd: project, ...resources });

		expect(resources.skills).toEqual([
			expect.objectContaining({
				name: "review",
				description: "explicit review",
				filePath: explicitPath,
				scope: "explicit",
			}),
		]);
		expect(resources.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: projectPath, stage: "collision" }),
				expect.objectContaining({ path: globalPath, stage: "collision" }),
			]),
		);
		expect(prompt).toContain(explicitPath);
		expect(prompt).not.toContain("explicit body");
	});

	it("skips project skills until project trust is granted", async () => {
		const root = await temporaryRoot();
		const project = join(root, "project");
		await writeSkill(join(project, ".di-code", "skills"), "project-skill", "project only");

		const resources = await loadResources({ cwd: project, agentDir: join(root, "agent"), projectTrusted: false });

		expect(resources.skills).toEqual([]);
		expect(resources.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "skill", stage: "trust", severity: "warning" })]),
		);
	});

	it("reports invalid skills and omits all resources when both loaders are disabled", async () => {
		const root = await temporaryRoot();
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "AGENTS.md"), "context", "utf8");
		await mkdir(join(agentDir, "skills", "invalid"), { recursive: true });
		await writeFile(join(agentDir, "skills", "invalid", "SKILL.md"), "---\nname: Invalid Name\n---\nbody", "utf8");

		const invalid = await loadResources({ cwd: project, agentDir });
		const disabled = await loadResources({ cwd: project, agentDir, noSkills: true, noContextFiles: true });

		expect(invalid.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "skill", stage: "parse", message: "description is required" }),
			]),
		);
		expect(disabled).toEqual({ contextFiles: [], skills: [], diagnostics: [] });
	});

	it("keeps explicitly invoked-only skills out of the model prompt", async () => {
		const root = await temporaryRoot();
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const skillDirectory = join(agentDir, "skills", "manual");
		await mkdir(skillDirectory, { recursive: true });
		await writeFile(
			join(skillDirectory, "SKILL.md"),
			"---\nname: manual\ndescription: Run only by explicit command.\ndisable-model-invocation: true\n---\nbody",
			"utf8",
		);

		const resources = await loadResources({ cwd: project, agentDir });
		const prompt = buildSystemPrompt({ cwd: project, ...resources });

		expect(resources.skills).toHaveLength(1);
		expect(prompt).not.toContain("Run only by explicit command.");
	});

	it("passes AGENTS instructions and the available skill list to the provider", async () => {
		const root = await temporaryRoot();
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "AGENTS.md"), "Use repository rules.", "utf8");
		const skillPath = await writeSkill(join(agentDir, "skills"), "review", "Review code safely.");
		const resources = await loadResources({ cwd: project, agentDir });
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "done" }] }] });
		let requestedContext: Context | undefined;
		const provider = {
			...faux.provider,
			stream(model: typeof faux.model, context: Context, options?: Parameters<typeof faux.provider.stream>[2]) {
				requestedContext = structuredClone(context);
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({
			allowedRoot: project,
			provider,
			model: faux.model,
			systemPrompt: buildSystemPrompt({ cwd: project, ...resources }),
		});

		await session.prompt("hello");

		expect(requestedContext?.systemPrompt).toContain("Use repository rules.");
		expect(requestedContext?.systemPrompt).toContain(skillPath);
	});
});
