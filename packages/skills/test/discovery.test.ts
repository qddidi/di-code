import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../src/index.ts";

describe("Skill discovery", () => {
	it("recurses in stable order and skips hidden and node_modules directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-skills-"));
		try {
			for (const name of ["b", "a", ".hidden", "node_modules/pkg"]) await mkdir(join(root, name), { recursive: true });
			for (const name of ["a", "b", ".hidden", "node_modules/pkg"])
				await writeFile(
					join(root, name, "SKILL.md"),
					`---\nname: ${name.replace(/[^a-z]/g, "x")}\ndescription: x\n---\nbody`,
					"utf8",
				);
			const results = await discoverSkills(root, "project");
			expect(results.map((result) => result.skill?.name)).toEqual(["a", "b"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symbolic-link discovery root", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-skills-"));
		try {
			const target = join(root, "target");
			const linked = join(root, "linked");
			await mkdir(target);
			await symlink(target, linked, "junction");
			const results = await discoverSkills(linked, "project");
			expect(results).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ diagnostics: [expect.objectContaining({ stage: "discover" })] }),
				]),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
