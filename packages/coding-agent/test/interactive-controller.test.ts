import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession } from "../src/core/session.ts";
import { InteractiveController } from "../src/interactive/controller.ts";
import { createCodingAgentPluginHost } from "../src/plugins/runtime-host.ts";

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

	it("exposes the complete frontend action surface with streaming tool events and multiline input", async () => {
		const root = await mkdtemp(join(process.cwd(), "interactive-controller-"));
		let host: ReturnType<typeof createCodingAgentPluginHost> | undefined;
		try {
			await writeFile(join(root, "notes.txt"), "controller tool output", "utf8");
			const manager = await SessionManager.create({ filePath: join(root, "session.jsonl"), cwd: root });
			const faux = createFauxProvider({
				responses: [
					{
						type: "success",
						content: [{ type: "tool_call", id: "read-1", name: "read", arguments: { path: "notes.txt" } }],
					},
					{ type: "success", content: [{ type: "text", text: "streamed answer" }] },
				],
			});
			const nextManager = await SessionManager.create({ filePath: join(root, "next-session.jsonl"), cwd: root });
			host = createCodingAgentPluginHost({ cwd: root, mode: "interactive", projectTrusted: true });
			await host.load(
				"fixture",
				(api) =>
					void api.registerCommand({
						name: "fixture-command",
						description: "fixture",
						handler: async (context) => context.notify("ran"),
					}),
			);
			const session = new AgentSession({
				allowedRoot: root,
				provider: faux.provider,
				model: faux.model,
				sessionManager: manager,
				runtimePluginHost: host,
			});
			const controller = new InteractiveController({
				session,
				runtimePluginHost: host,
				sessions: [
					{
						id: "next",
						label: "Next",
						open: () =>
							new AgentSession({
								allowedRoot: root,
								provider: faux.provider,
								model: faux.model,
								sessionManager: nextManager,
							}),
					},
				],
			});
			sessions.push(controller);
			const events: Array<{ type: string; event?: unknown }> = [];
			controller.subscribe((event) =>
				events.push({ type: event.type, event: event.type === "session_event" ? event.event : undefined }),
			);
			await controller.submit("  first line\nsecond line  ");
			await controller.runCommand("fixture-command", "");
			controller.selectModel(faux.model.id);
			expect(controller.state.model).toBe(faux.model.id);
			expect(controller.state.messages).toContain("streamed answer");
			expect(
				events.some(
					(event) =>
						event.type === "session_event" && (event.event as { type?: string })?.type === "tool_execution_start",
				),
			).toBe(true);
			expect(
				events.some(
					(event) =>
						event.type === "session_event" && (event.event as { type?: string })?.type === "tool_execution_end",
				),
			).toBe(true);
			expect(events.some((event) => event.type === "state")).toBe(true);
			await expect(controller.requestCompaction()).rejects.toThrow("No valid compaction cut point");
			await controller.openSession("next");
			expect(controller.state.sessionId).toBe(nextManager.header.id);
		} finally {
			await host?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
