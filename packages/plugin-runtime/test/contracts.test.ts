import { describe, expect, it } from "vitest";
import { isPluginStatus, isRuntimeEvent, isRuntimeMode } from "../src/index.ts";

describe("runtime contract guards", () => {
	it("recognizes the closed plugin status union", () => {
		expect(isPluginStatus("active")).toBe(true);
		expect(isPluginStatus("unknown")).toBe(false);
	});

	it("recognizes runtime modes", () => {
		expect(isRuntimeMode("print")).toBe(true);
		expect(isRuntimeMode("webui")).toBe(true);
		expect(isRuntimeMode("server")).toBe(false);
	});

	it("uses the RuntimeEvent discriminant", () => {
		expect(isRuntimeEvent({ type: "context_created", contextId: "ctx-1" })).toBe(true);
		expect(isRuntimeEvent({ type: "not-an-event" })).toBe(false);
		expect(isRuntimeEvent(null)).toBe(false);
	});
});
