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
		expect(result.status).toBe("completed");
		expect(result.text).toContain("truncated");
		expect(events).toEqual(["subagent_start", "subagent_end"]);
		const wait = service.createTools().find((tool) => tool.name === "wait");
		if (!wait) throw new Error("wait tool is missing");
		const toolResult = await wait.execute("call-1", { id: run.id }, undefined);
		const content = "content" in toolResult ? toolResult.content : toolResult;
		expect(JSON.parse(content[0]?.type === "text" ? content[0].text : "{}")).toMatchObject({
			id: run.id,
			status: "completed",
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
