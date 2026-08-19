import { describe, expect, it } from "vitest";
import { createSkillCatalog, type SkillLoadResult } from "../src/index.ts";

const skill = (name: string, source: "project" | "user", disableModelInvocation = false, userInvocable = true) => ({
	skill: {
		kind: "skill" as const,
		name,
		description: name,
		filePath: `/${name}.md`,
		baseDir: "/",
		source,
		disableModelInvocation,
		userInvocable,
	},
	diagnostics: [],
});

describe("Skill catalog", () => {
	it("keeps first source, records collision, and filters visibility", () => {
		const catalog = createSkillCatalog([
			skill("review", "project"),
			skill("review", "user"),
			skill("manual", "user", true, false) satisfies SkillLoadResult,
		]);
		expect(catalog.resolve("review")?.source).toBe("project");
		expect(catalog.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "collision" })]));
		expect(catalog.listForModel().map((item) => item.name)).toEqual(["review"]);
		expect(catalog.listForUser().map((item) => item.name)).toEqual(["review"]);
	});
});
