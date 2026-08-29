import type { SessionEventEnvelope, SessionToolPolicy } from "@di-code/plugin-sdk";
import { createFakeInteractionProvider, createPromptSectionRegistry, createUserInteraction } from "@di-code/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	createPlanModePlugin,
	createPlanToolPolicy,
	EXIT_PLAN_MODE,
	foldPlanMode,
	PlanModeController,
	projectPlanMode,
} from "../src/index.ts";

function harness(busy = false) {
	const events: SessionEventEnvelope[] = [];
	const sections = createPromptSectionRegistry();
	return {
		events: () => events,
		appendEvent: async (event: SessionEventEnvelope) => {
			events.push(structuredClone(event));
		},
		isBusy: () => busy,
		promptSections: sections,
		sections,
		adapter: {
			sessionId: "s1",
			events: () => events,
			appendEvent: async (event: SessionEventEnvelope) => {
				events.push(structuredClone(event));
			},
			isBusy: () => busy,
			promptSections: sections,
		},
	};
}

describe("plan-mode", () => {
	it("logs mode changes and replays active/pending projection", async () => {
		const h = harness();
		const controller = new PlanModeController(h.adapter, { section: "Plan carefully." });
		expect(controller.get()).toEqual({ active: false, pending: false });
		expect(controller.set(true)).toBe("committed");
		await vi.waitFor(() => expect(foldPlanMode(h.events())).toBe(true));
		expect(controller.get()).toEqual({ active: true, pending: false });
		expect(projectPlanMode(h.events(), false)).toEqual({ active: true, pending: true });
		expect(h.sections.snapshot()[0]?.name).toBe("plan:policy");
	});

	it("keeps failed pre-step writes pending for retry", async () => {
		let fail = true;
		const events: SessionEventEnvelope[] = [];
		const controller = new PlanModeController(
			{
				sessionId: "s",
				events: () => events,
				appendEvent: async (event: SessionEventEnvelope) => {
					if (fail) throw new Error("disk");
					events.push(event as never);
				},
				isBusy: () => true,
			},
			{ section: "Plan" },
		);
		controller.set(true);
		await expect(controller.preStep()).rejects.toThrow("disk");
		expect(controller.get()).toEqual({ active: false, pending: true });
		fail = false;
		await controller.preStep();
		expect(controller.get()).toEqual({ active: true, pending: false });
	});

	it("rejects mutation tools and supports approve/keep/cancel review", async () => {
		const provider = createFakeInteractionProvider();
		const interaction = createUserInteraction(provider);
		const h = harness();
		const controller = new PlanModeController({ ...h.adapter, interaction }, { section: "Plan" });
		controller.set(true);
		await vi.waitFor(() => expect(controller.get().active).toBe(true));
		expect(() => controller.authorize("write")).toThrow(/denied/);
		const pending = controller.exit("# Ship it\n\n1. Test", new AbortController().signal);
		const request = provider.requests[0];
		expect(request?.intent).toBe("plan-review");
		provider.answer(request?.requestId ?? "", { status: "answered", value: "keep", feedback: "Add tests" });
		await expect(pending).rejects.toThrow(/Add tests/);
		await interaction.dispose();
	});

	it("exports a stable exit tool and plugin factory", () => {
		const h = harness();
		const plugin = createPlanModePlugin({ section: "Plan" });
		const controller = plugin.createController(h.adapter);
		expect(plugin.name).toBe("plan-mode");
		expect(controller.createExitTool().name).toBe(EXIT_PLAN_MODE);
	});

	it("composes with an existing policy", async () => {
		const h = harness();
		const controller = new PlanModeController(h.adapter, { section: "Plan" });
		const base: SessionToolPolicy = {
			snapshot: () => ({ mode: "normal", revision: 0, sessionId: "s" }),
			setMode: async (_mode) => ({ mode: "normal", revision: 0, sessionId: "s" }),
			authorize: async () => undefined,
		};
		const policy = createPlanToolPolicy(base, controller);
		controller.set(true);
		await vi.waitFor(() => expect(controller.get().active).toBe(true));
		await expect(
			policy.authorize(
				"bash",
				{},
				{
					sessionId: "s",
					snapshot: base.snapshot(),
					projection: {},
					pluginState: {},
					signal: new AbortController().signal,
				},
			),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
	});
});
