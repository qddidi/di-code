import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillCatalog, loadSkill, resolveSkillInvocation } from "../src/index.ts";

describe("Skill invocation", () => {
	it("expands arguments and preserves ordinary prompts", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-skills-"));
		try {
			const path = join(root, "SKILL.md");
			await writeFile(path, "---\nname: review\ndescription: Review\n---\nReview $1 ($ARGUMENTS)", "utf8");
			const result = await loadSkill(path, "explicit");
			const catalog = createSkillCatalog([result]);
			expect(await resolveSkillInvocation("hello", catalog)).toBe("hello");
			expect(await resolveSkillInvocation("/skill:review api login", catalog)).toContain("Review api (api login)");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
