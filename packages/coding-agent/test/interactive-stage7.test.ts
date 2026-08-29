import { Key, matchesKey } from "@di-code/tui";
import { describe, expect, it } from "vitest";
import {
	InteractiveChat,
	InteractiveFooter,
	InteractiveHeader,
	type InteractiveViewState,
} from "../src/modes/interactive-components.ts";
import { InteractiveProjection } from "../src/modes/interactive-state.ts";

describe("TUI extension surface", () => {
	it("keeps extension status visible at narrow widths", () => {
		const projection = new InteractiveProjection();
		const state: InteractiveViewState = {
			...projection.state,
			model: "faux-model",
			theme: "dark",
			extensions: [{ label: "Plan", tone: "info" }],
		};
		const output = new InteractiveChat(() => state).render(24).join("\n");
		expect(output).toContain("Plan");
	});

	it("shows plan mode state beside the model and shortcut in the footer", () => {
		const projection = new InteractiveProjection();
		const state: InteractiveViewState = {
			...projection.state,
			model: "faux-model",
			theme: "dark",
			planMode: { active: true, pending: false },
		};
		const footer = new InteractiveFooter(() => state).render(100).join("\n");
		expect(new InteractiveHeader(() => state).render(100).join("\n")).not.toContain("plan: ON");
		expect(footer).toContain("plan: ON");
		expect(footer).toContain("Alt+P Plan");
		expect(matchesKey("\x1bp", Key.alt("p"))).toBe(true);
	});
});
