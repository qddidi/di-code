import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { InteractiveController } from "../src/interactive/controller.ts";

const sessions: InteractiveController[] = [];
afterEach(() => {
	for (const controller of sessions) controller.dispose();
	sessions.length = 0;
});

function createController(responses: Parameters<typeof createFauxProvider>[0]["responses"] = []) {
	const faux = createFauxProvider({ responses });
	const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
	const controller = new InteractiveController({ session });
	sessions.push(controller);
	return { controller, session };
}

describe("InteractiveController", () => {
	it("projects session events and final state without exposing Agent internals", async () => {
		const { controller } = createController([{ type: "success", content: [{ type: "text", text: "answer" }] }]);
		const events: string[] = [];
		controller.subscribe((event) => events.push(event.type));
		await controller.submit("hello");
		expect(events).toContain("session_event");
		expect(controller.state.messages).toContain("answer");
		expect(controller.state.streaming).toBe(false);
	});

	it("queues a second submission and cancels the active request", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first" }] },
				{ type: "success", content: [{ type: "text", text: "second" }] },
			],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const controller = new InteractiveController({ session });
		sessions.push(controller);
		const first = controller.submit("one");
		await controller.submit("two");
		controller.cancel();
		await first;
		for (let attempt = 0; attempt < 20 && controller.state.streaming; attempt++)
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		expect(controller.state.streaming).toBe(false);
		expect(controller.state.queue.length).toBeLessThanOrEqual(1);
	});

	it("retries the most recent failed prompt through the frontend-safe controller action", async () => {
		const { controller } = createController([
			{ type: "failure", errorMessage: "temporary failure" },
			{ type: "success", content: [{ type: "text", text: "recovered" }] },
		]);
		await controller.submit("try again");
		await controller.retry();
		expect(controller.state.messages).toContain("recovered");
		await expect(controller.retry()).rejects.toThrow("There is no failed or cancelled prompt");
	});
});
