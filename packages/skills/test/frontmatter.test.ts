import { describe, expect, it } from "vitest";
import { parseSkillDocument } from "../src/frontmatter.ts";

describe("Skill frontmatter", () => {
	it("parses YAML booleans, defaults, and CRLF", () => {
		const result = parseSkillDocument(
			"\uFEFF---\r\nname: release-check\r\ndescription: Check releases.\r\ndisable-model-invocation: true\r\n---\r\nbody",
			"SKILL.md",
		);
		expect(result.document?.metadata).toEqual({
			name: "release-check",
			description: "Check releases.",
			disableModelInvocation: true,
			userInvocable: true,
		});
		expect(result.document?.body).toBe("body");
	});

	it("rejects invalid metadata and duplicate YAML keys", () => {
		expect(
			parseSkillDocument("---\nname: Bad Name\nname: other\ndescription: x\n---\nbody", "SKILL.md").document,
		).toBeUndefined();
		expect(
			parseSkillDocument("---\nname: ok\ndescription: x\nuser-invocable: yes\n---\nbody", "SKILL.md").diagnostics,
		).toEqual(expect.arrayContaining([expect.objectContaining({ message: "user-invocable must be a YAML boolean" })]));
	});
});
