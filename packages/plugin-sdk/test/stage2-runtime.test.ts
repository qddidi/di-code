import { describe, expect, it } from "vitest";
import { createExtensionContext, ExtensionRuntimeError, InMemorySubagentService } from "../src/index.ts";

describe("freedom stage 2 runtime", () => {
	it("binds an unavailable session and UI with stable error codes", async () => {
		const ctx = createExtensionContext({ extensionId: "test" as never });
		await expect(ctx.session.snapshot()).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE" });
		await expect(ctx.ui.custom({ title: "x", body: null })).rejects.toMatchObject({ code: "UI_UNAVAILABLE" });
	});

	it("emits events and keeps cancellation local to one child", async () => {
		const service = new InMemorySubagentService({
			runSubagent: async (input, signal, emit) => {
				await emit({ type: "text_delta", data: input.prompt });
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return { version: 1, taskId: "pending" as never, text: input.prompt };
			},
		});
		const first = await service.start({ prompt: "one", label: "first", mode: "continuable" });
		const second = await service.start({ prompt: "two", label: "second" });
		await first.followup("three");
		await first.cancel();
		expect((await service.get(second.taskId)).state).toBe("running");
		const event = await first.events[Symbol.asyncIterator]().next();
		expect(event.value?.type).toBe("text_delta");
		await second.cancel();
	});

	it("rejects reconciliation outside needs_reconciliation and conflicting idempotency", async () => {
		const service = new InMemorySubagentService();
		const run = await service.start({ prompt: "done", label: "task" });
		await run.result;
		await expect(
			service.reconcileTask({ taskId: run.taskId, idempotencyKey: "x", decision: { type: "cancel", reason: "x" } }),
		).rejects.toBeInstanceOf(ExtensionRuntimeError);
	});
});
