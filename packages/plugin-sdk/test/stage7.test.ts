import { describe, expect, it } from "vitest";
import { EXTENSION_FACADE_API_VERSION, type ExtensionUiContribution } from "../src/index.ts";

describe("stage 7 extension facade contract", () => {
	it("uses a versioned declarative contribution shape", () => {
		const contribution: ExtensionUiContribution = {
			id: "plan-review",
			surface: "review",
			slot: "review.panel",
			version: EXTENSION_FACADE_API_VERSION,
			componentKey: "builtin.plan-review",
			data: { state: "pending", count: 1 },
		};
		expect(contribution.version).toBe(1);
		expect(contribution.componentKey).not.toContain("/");
	});
});
