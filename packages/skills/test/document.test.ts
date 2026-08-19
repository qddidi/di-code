import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkill, MAX_SKILL_BYTES, readSkillContent } from "../src/index.ts";

describe("Skill documents", () => {
	it("loads and reads bounded content", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-skills-"));
		try {
			const path = join(root, "SKILL.md");
			await writeFile(path, "---\nname: test\ndescription: Test\n---\nbody", "utf8");
			const result = await loadSkill(path, "explicit");
			expect(result.skill?.source).toBe("explicit");
			if (!result.skill) throw new Error("Expected a valid Skill");
			expect(await readSkillContent(result.skill)).toBe("body");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects oversized content", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-skills-"));
		try {
			await mkdir(root, { recursive: true });
			const path = join(root, "SKILL.md");
			await writeFile(path, Buffer.alloc(MAX_SKILL_BYTES + 1));
			expect((await loadSkill(path, "user")).diagnostics[0]?.stage).toBe("read");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
