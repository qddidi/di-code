import { describe, expect, it } from "vitest";
import { resolveWebRuntime } from "../src/web-command.ts";

describe("resolveWebRuntime", () => {
	it("falls back to Faux when the selected Provider cannot be configured yet", () => {
		const runtime = resolveWebRuntime({ environment: { DI_CODE_PROVIDER: "zhipu" }, providers: [] });

		expect(runtime.provider.id).toBe("faux");
		expect(runtime.model.id).toBe("faux-model");
	});

	it("keeps a configured Provider as the Web runtime", () => {
		const runtime = resolveWebRuntime({
			environment: { DI_CODE_PROVIDER: "zhipu", ZAI_API_KEY: "test-key" },
			providers: [],
		});

		expect(runtime.provider.id).toBe("zhipu");
		expect(runtime.model.id).toBe("glm-5.3");
	});
});
