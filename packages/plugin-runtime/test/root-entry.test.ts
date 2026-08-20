import { describe, expect, it } from "vitest";
import * as pluginRuntime from "../src/index.ts";

describe("plugin runtime package boundary", () => {
	it("exposes an importable root entry before runtime contracts are introduced", () => {
		expect(Object.keys(pluginRuntime)).toEqual([]);
	});
});
