import { createFauxProvider } from "@di-code/ai";
import type { SubagentProvider } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { SubagentService } from "../src/subagents/service.ts";

describe("SubagentService", () => {
	it("runs a child through the shared Agent loop and bounds its result", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "child result that is longer" }] }],
		});
		const events: string[] = [];
		const service = new SubagentService({
			parentSessionId: "parent",
			cwd: process.cwd(),
			provider: faux.provider,
			model: faux.model,
			maxResultBytes: 20,
			emit: (event) => {
				events.push(event.type);
			},
			createSession: () =>
				new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model, subagents: false }),
		});
		const run = await service.start({ prompt: "work" });
		const result = await run.wait();
		expect(await run.wait()).toEqual(result);
		expect(result.status).toBe("completed");
		expect(result.text).toContain("truncated");
		expect(service.list()).toEqual([]);
		expect(events).toEqual(["subagent_start", "subagent_end"]);
		const wait = service.createTools().find((tool) => tool.name === "wait");
		if (!wait) throw new Error("wait tool is missing");
		const toolResult = await wait.execute("call-1", { id: run.id }, undefined);
		const content = "content" in toolResult ? toolResult.content : toolResult;
		expect(JSON.parse(content[0]?.type === "text" ? content[0].text : "{}")).toMatchObject({
			id: run.id,
			status: "completed",
		});
		expect(service.list()).toEqual([]);
		await service.dispose();
		await service.dispose();
	});

	it("reclaims failed and cancelled runs while keeping cancellation idempotent", async () => {
		const faux = createFauxProvider({ responses: [] });
		const failedProvider: SubagentProvider = {
			id: "failed",
			start: async (request) => ({
				id: "failed-run",
				parentSessionId: request.parentSessionId,
				providerId: "failed",
				status: "running",
				wait: async () => ({ id: "failed-run", status: "failed", text: "failed" }),
				sendMessage: async () => undefined,
				cancel: async () => undefined,
			}),
		};
		const service = new SubagentService({
			parentSessionId: "parent",
			cwd: process.cwd(),
			provider: faux.provider,
			model: faux.model,
			providers: [failedProvider],
			createSession: () =>
				new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model, subagents: false }),
		});

		const failed = await service.start({ prompt: "fail", providerId: "failed" });
		await expect(failed.wait()).resolves.toMatchObject({ status: "failed" });
		expect(service.list()).toEqual([]);

		let resolveWait!: (result: { id: string; status: "completed"; text: string }) => void;
		let cancelled = 0;
		const cancellableProvider: SubagentProvider = {
			id: "cancellable",
			start: async (request) => ({
				id: "cancelled-run",
				parentSessionId: request.parentSessionId,
				providerId: "cancellable",
				status: "running",
				wait: () =>
					new Promise((resolve) => {
						resolveWait = resolve;
					}),
				sendMessage: async () => undefined,
				cancel: async () => {
					cancelled++;
				},
			}),
		};
		const cancellableService = new SubagentService({
			parentSessionId: "parent",
			cwd: process.cwd(),
			provider: faux.provider,
			model: faux.model,
			providers: [cancellableProvider],
			createSession: () =>
				new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model, subagents: false }),
		});
		const cancelledRun = await cancellableService.start({ prompt: "cancel", providerId: "cancellable" });
		await cancellableService.interrupt(cancelledRun.id);
		await cancellableService.interrupt(cancelledRun.id);
		resolveWait?.({ id: cancelledRun.id, status: "completed", text: "late" });
		await expect(cancelledRun.wait()).resolves.toMatchObject({ status: "cancelled" });
		await cancellableService.interrupt(cancelledRun.id);
		expect(cancellableService.list()).toEqual([]);
		expect(cancelled).toBe(1);
		await cancellableService.dispose();
		await cancellableService.dispose();
	});

	it("routes reused run IDs to the active run instead of a stale terminal result", async () => {
		const faux = createFauxProvider({ responses: [] });
		let starts = 0;
		let resolveSecond!: (result: { id: string; status: "completed"; text: string }) => void;
		let secondCancelled = 0;
		const provider: SubagentProvider = {
			id: "reused",
			start: async (request) => {
				starts++;
				return {
					id: "reused-run",
					parentSessionId: request.parentSessionId,
					providerId: "reused",
					status: "running" as const,
					wait:
						starts === 1
							? async () => ({ id: "reused-run", status: "completed" as const, text: "first result" })
							: () =>
									new Promise((resolve) => {
										resolveSecond = resolve;
									}),
					sendMessage: async () => undefined,
					cancel: async () => {
						if (starts === 2) secondCancelled++;
					},
				};
			},
		};
		const service = new SubagentService({
			parentSessionId: "parent",
			cwd: process.cwd(),
			provider: faux.provider,
			model: faux.model,
			providers: [provider],
			createSession: () =>
				new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model, subagents: false }),
		});

		const first = await service.start({ prompt: "first", providerId: "reused" });
		await expect(first.wait()).resolves.toMatchObject({ text: "first result" });
		const second = await service.start({ prompt: "second", providerId: "reused" });
		await service.interrupt(second.id);
		resolveSecond({ id: second.id, status: "completed", text: "second result" });
		await expect(second.wait()).resolves.toMatchObject({ status: "cancelled" });
		expect(secondCancelled).toBe(1);
		const wait = service.createTools().find((tool) => tool.name === "wait");
		if (!wait) throw new Error("wait tool is missing");
		const toolResult = await wait.execute("call-1", { id: second.id }, undefined);
		const content = "content" in toolResult ? toolResult.content : toolResult;
		expect(content[0]?.type === "text" ? JSON.parse(content[0].text) : {}).toMatchObject({
			id: second.id,
			status: "cancelled",
		});
		await service.dispose();
	});

	it("enforces depth, concurrency, and unknown provider boundaries", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }] });
		const service = new SubagentService({
			parentSessionId: "parent",
			cwd: process.cwd(),
			provider: faux.provider,
			model: faux.model,
			maxDepth: 0,
			createSession: () =>
				new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model, subagents: false }),
		});
		await expect(service.start({ prompt: "too deep" })).rejects.toThrow("between 0 and 0");
		await expect(service.start({ prompt: "x", depth: 0, providerId: "missing" })).rejects.toThrow(
			"Unknown subagent provider",
		);
	});

	it("normalizes provider timeout, cancellation, and credential redaction", async () => {
		let cancelled = false;
		const events: string[] = [];
		const provider: SubagentProvider = {
			id: "fixture",
			start: async (request) => ({
				id: "fixture-run",
				parentSessionId: request.parentSessionId,
				providerId: "fixture",
				status: "running",
				wait: () => new Promise(() => undefined),
				sendMessage: async () => undefined,
				cancel: async () => {
					cancelled = true;
				},
			}),
		};
		const faux = createFauxProvider({ responses: [] });
		const service = new SubagentService({
			parentSessionId: "parent",
			cwd: process.cwd(),
			provider: faux.provider,
			model: faux.model,
			providers: [provider],
			defaultTimeoutMs: 10,
			maxResultBytes: 8,
			emit: (event) => {
				events.push(event.type);
			},
			createSession: () =>
				new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model, subagents: false }),
		});
		const run = await service.start({ prompt: "work", providerId: "fixture" });
		const result = await run.wait();
		expect(result.status).toBe("cancelled");
		expect(cancelled).toBe(true);
		expect(events).toEqual(["subagent_start", "subagent_end"]);
		await service.dispose();
	});
});
