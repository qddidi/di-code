import { describe, expect, it } from "vitest";
import { resolveStartupArgs, resolveStartupRuntime } from "../src/startup.ts";

describe("resolveStartupArgs", () => {
	it("starts interactive mode when the process receives no arguments", () => {
		expect(resolveStartupArgs([])).toEqual(["--interactive"]);
	});

	it("preserves explicit CLI arguments", () => {
		expect(resolveStartupArgs(["--help"])).toEqual(["--help"]);
		expect(resolveStartupArgs(["--mode", "json", "hello"])).toEqual(["--mode", "json", "hello"]);
	});
});

describe("resolveStartupRuntime", () => {
	it("defaults to OpenAI and selects the configured catalog model", () => {
		const runtime = resolveStartupRuntime({
			OPENAI_API_KEY: "test-key",
			OPENAI_MODEL: "gpt-4o",
		});

		expect(runtime.provider.id).toBe("openai");
		expect(runtime.model.id).toBe("gpt-4o");
		expect(runtime.provider.models.map((model) => model.id)).toContain("gpt-4o");
	});

	it("accepts an explicit OpenAI provider with trimmed configuration", () => {
		const runtime = resolveStartupRuntime({
			DI_CODE_PROVIDER: " openai ",
			OPENAI_API_KEY: "test-key",
			OPENAI_MODEL: " o3-mini ",
		});

		expect(runtime.provider.id).toBe("openai");
		expect(runtime.model.id).toBe("o3-mini");
	});

	it("requires a model before constructing the OpenAI provider", () => {
		expect(() => resolveStartupRuntime({ OPENAI_API_KEY: "test-key" })).toThrow(
			"OPENAI_MODEL is required when DI_CODE_PROVIDER=openai",
		);
	});

	it("requires an API key without including credential values in the error", () => {
		expect(() => resolveStartupRuntime({ OPENAI_MODEL: "gpt-4o" })).toThrow("OpenAI API key is required");
	});

	it("rejects a model outside the OpenAI catalog", () => {
		expect(() =>
			resolveStartupRuntime({
				OPENAI_API_KEY: "test-key",
				OPENAI_MODEL: "not-a-model",
			}),
		).toThrow('Unknown OpenAI model "not-a-model". Available models: gpt-4o, o3-mini.');
	});

	it("rejects an unsupported provider before inspecting provider credentials", () => {
		expect(() => resolveStartupRuntime({ DI_CODE_PROVIDER: "other" })).toThrow(
			'Unsupported DI_CODE_PROVIDER "other". Expected openai or faux.',
		);
	});

	it("uses the deterministic Faux provider only when explicitly selected", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "faux" });

		expect(runtime.provider.id).toBe("faux");
		expect(runtime.model).toEqual(runtime.provider.models[0]);
	});
});
