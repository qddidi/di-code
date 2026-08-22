import { describe, expect, it } from "vitest";
import { createServiceKey, getPluginDefinition, isRuntimeMode } from "../src/index.ts";

describe("plugin SDK root exports", () => {
	it("re-exports runtime and loader contracts", () => {
		expect(typeof createServiceKey).toBe("function");
		expect(isRuntimeMode("test")).toBe(true);
		expect(getPluginDefinition({ name: "sdk.fixture", apply: () => undefined }).name).toBe("sdk.fixture");
	});
});
