import { describe, expect, it } from "vitest";
import { createFakeInteractionProvider, createUserInteraction } from "../src/index.ts";

describe("UserInteraction", () => {
	it("supports approval, rejection, cancellation and timeout", async () => {
		const provider = createFakeInteractionProvider();
		const interaction = createUserInteraction(provider);
		const approval = interaction.request({
			requestId: "approve",
			kind: "approval",
			prompt: "Run write?",
			toolCallId: "tool-1",
		});
		provider.answer("approve", { status: "answered", approved: true });
		await expect(approval).resolves.toMatchObject({ status: "answered", approved: true, toolCallId: "tool-1" });
		const rejected = interaction.request({ requestId: "reject", kind: "approval", prompt: "Run bash?" });
		provider.answer("reject", { status: "answered", approved: false, feedback: "keep planning" });
		await expect(rejected).resolves.toMatchObject({ approved: false, feedback: "keep planning" });
		const controller = new AbortController();
		const cancelled = interaction.request(
			{ requestId: "cancel", kind: "question", prompt: "Anything?" },
			controller.signal,
		);
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ code: "INTERACTION_CANCELLED" });
		await expect(
			interaction.request({ requestId: "timeout", kind: "question", prompt: "Wait", timeoutMs: 1 }),
		).rejects.toMatchObject({ code: "INTERACTION_TIMEOUT" });
		await interaction.dispose();
	});

	it("supports multi-question choices and idempotent duplicate answers", async () => {
		const provider = createFakeInteractionProvider();
		const interaction = createUserInteraction(provider);
		const input = interaction.request({
			requestId: "multi",
			kind: "questions",
			prompt: "Review",
			questions: [{ id: "mode", prompt: "Mode", options: [{ value: "plan", label: "Plan" }] }],
		});
		expect(interaction.answer("multi", { status: "answered", values: { mode: "plan" } })).toBe(true);
		expect(interaction.answer("multi", { status: "answered", values: { mode: "other" } })).toBe(true);
		await expect(input).resolves.toMatchObject({ values: { mode: "plan" } });
		await interaction.dispose();
	});

	it("fails fast without a UI channel and after unload", async () => {
		const interaction = createUserInteraction();
		await expect(interaction.request({ kind: "question", prompt: "No UI" })).rejects.toMatchObject({
			code: "INTERACTION_UNAVAILABLE",
		});
		await interaction.dispose();
		await expect(interaction.request({ kind: "question", prompt: "Disposed" })).rejects.toMatchObject({
			code: "INTERACTION_DISPOSED",
		});
	});

	it("enforces timeout even when the provider ignores AbortSignal", async () => {
		const interaction = createUserInteraction({
			request: async () =>
				await new Promise((resolve) =>
					setTimeout(() => resolve({ requestId: "slow", status: "answered", value: "late" }), 20),
				),
		});
		await expect(
			interaction.request({ requestId: "slow", kind: "question", prompt: "Wait", timeoutMs: 1 }),
		).rejects.toMatchObject({
			code: "INTERACTION_TIMEOUT",
		});
		await interaction.dispose();
	});
});
