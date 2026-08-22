import { describe, expect, it } from "vitest";
import { getPluginDefinition, isPluginDefinition } from "../src/index.ts";
import * as fixture from "./fixtures/namespace-plugin.ts";

describe("namespace plugin loader contract", () => {
	it("loads a real namespace export fixture without a default", () => {
		const definition = getPluginDefinition(fixture);
		expect(definition.name).toBe("fixture.namespace");
		expect(isPluginDefinition(definition)).toBe(true);
		expect("default" in fixture).toBe(false);
	});

	it("rejects default exports", () => {
		expect(() => getPluginDefinition({ default: { name: "bad", apply: () => undefined } })).toThrow(/default export/);
	});

	it("rejects incomplete definitions", () => {
		expect(isPluginDefinition({ name: "missing-apply" })).toBe(false);
		expect(() => getPluginDefinition({ name: "missing-apply" })).toThrow(/apply function/);
	});
});
