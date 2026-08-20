import { describe, expect, it } from "vitest";
import { listRuntimeProfiles, resolveRuntimeProfile } from "../src/plugins/profile.ts";

describe("runtime profiles", () => {
	it("merges user, project, and CLI overrides in order", () => {
		expect(
			resolveRuntimeProfile("terminal", {
				user: { pluginIds: ["user"], frontend: "builtin" },
				project: { pluginIds: ["project"] },
				cli: { pluginIds: ["cli"] },
			}),
		).toMatchObject({ name: "terminal", mode: "interactive", frontend: "builtin", pluginIds: ["cli"] });
	});

	it("rejects unknown, duplicate, and incompatible profile selections", () => {
		expect(() => resolveRuntimeProfile("missing")).toThrow("Unknown runtime profile");
		expect(() => resolveRuntimeProfile("terminal", { cli: { pluginIds: ["dup", "dup"] } })).toThrow("duplicate");
		expect(() => resolveRuntimeProfile("headless", {}, "interactive")).toThrow("headless");
	});

	it("lists defensive copies of built-in profiles", () => {
		expect(listRuntimeProfiles().map((profile) => profile.name)).toEqual(["terminal", "headless"]);
	});
});
