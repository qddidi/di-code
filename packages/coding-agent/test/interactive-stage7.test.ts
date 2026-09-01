import { Key, matchesKey, visibleWidth } from "@di-code/tui";
import { describe, expect, it } from "vitest";
import {
	AutocompleteMenu,
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

	it("uses a complete compact shortcut hint at narrow widths", () => {
		const projection = new InteractiveProjection();
		const state: InteractiveViewState = {
			...projection.state,
			model: "glm-4.7",
			theme: "dark",
			locale: "zh-CN",
		};
		const hint = new InteractiveFooter(() => state).render(80).at(-1) ?? "";
		expect(visibleWidth(hint)).toBeLessThanOrEqual(80);
		expect(hint).toContain("Esc 取消");
		expect(hint).not.toContain("Ctrl+O");
	});

	it("keeps the selected autocomplete item visible when only one row fits", () => {
		const menu = new AutocompleteMenu(
			() => ({
				items: Array.from({ length: 8 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` })),
				index: 7,
			}),
			1,
		);
		const output = menu.render(40).join("\n");
		expect(output).toContain("item-7");
		expect(output).not.toContain("item-0");
	});

	it("recalculates autocomplete rows after a terminal resize", () => {
		let maxVisible = 6;
		const menu = new AutocompleteMenu(
			() => ({
				items: Array.from({ length: 8 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` })),
				index: 7,
			}),
			() => maxVisible,
		);
		expect(menu.render(40).filter((line) => line.includes("item-")).length).toBe(6);
		maxVisible = 1;
		expect(menu.render(40).filter((line) => line.includes("item-")).length).toBe(1);
	});

	it("shows the selected autocomplete item as a single line in an extremely short terminal", () => {
		const menu = new AutocompleteMenu(
			() => ({
				items: [
					{ value: "item-0", label: "item-0" },
					{ value: "item-1", label: "item-1" },
				],
				index: 1,
			}),
			0,
		);
		expect(menu.render(20)[0]).toContain("item-1");
	});
});
