import { createRootContext } from "@di-code/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
	credentialEnv,
	credentialEnvKey,
	providerRegistry,
	providerRegistryKey,
	runtimeSelection,
	runtimeSelectionKey,
} from "../src/index.ts";

const originalProvider = process.env.DI_CODE_PROVIDER;
const originalModel = process.env.DI_CODE_MODEL;
const originalKey = process.env.TEST_PROVIDER_KEY;

afterEach(() => {
	if (originalProvider === undefined) delete process.env.DI_CODE_PROVIDER;
	else process.env.DI_CODE_PROVIDER = originalProvider;
	if (originalModel === undefined) delete process.env.DI_CODE_MODEL;
	else process.env.DI_CODE_MODEL = originalModel;
	if (originalKey === undefined) delete process.env.TEST_PROVIDER_KEY;
	else process.env.TEST_PROVIDER_KEY = originalKey;
});

describe("provider composition entries", () => {
	it("resolves credential environment references without exposing the value in errors", async () => {
		process.env.TEST_PROVIDER_KEY = "test-secret";
		const context = createRootContext({ id: "provider-test" });
		try {
			await context.plugin(credentialEnv, undefined);
			const resolver = context.require(credentialEnvKey);
			expect(resolver.resolve("$TEST_PROVIDER_KEY", "provider.apiKey")).toBe("test-secret");
			expect(() => resolver.resolve("$MISSING_PROVIDER_KEY", "provider.apiKey")).toThrow("MISSING_PROVIDER_KEY");
			expect(() => resolver.resolve("!command", "provider.apiKey")).toThrow("command-based");
		} finally {
			await context.dispose();
		}
	});

	it("selects faux through the registry and reports unknown models", async () => {
		process.env.DI_CODE_PROVIDER = "faux";
		process.env.DI_CODE_MODEL = "faux-model";
		const context = createRootContext({ id: "selection-test" });
		try {
			await context.plugin(providerRegistry, undefined);
			const faux = (await import("@di-code/ai")).createFauxProvider({ responses: [] });
			context.require(providerRegistryKey).register({ provider: faux.provider, model: faux.model });
			await context.plugin(runtimeSelection, undefined);
			expect(context.require(runtimeSelectionKey).selected().provider.id).toBe("faux");
			process.env.DI_CODE_MODEL = "does-not-exist";
			expect(() => context.require(runtimeSelectionKey).selected()).toThrow('Unknown model "does-not-exist"');
		} finally {
			await context.dispose();
		}
	});
});
