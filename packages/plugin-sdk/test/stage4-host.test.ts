import { describe, expect, it } from "vitest";
import {
	createExtensionAPI,
	createExtensionHostServices,
	createFauxProvider,
	type JobStartInput,
	type SessionId,
} from "../src/index.ts";

describe("freedom stage 4 host capabilities", () => {
	it("registers all ordinary extension surfaces without owner or wire plumbing", async () => {
		const api = createExtensionAPI("demo", { context: {} });
		api.registerCommand({ name: "hello", description: "hello", run: async () => ({ version: 1, text: "ok" }) });
		api.registerTool({
			name: "echo",
			description: "echo",
			schema: { type: "object", properties: {}, required: [], additionalProperties: false },
			execute: async () => ({ version: 1, content: null, truncated: false }),
		});
		api.registerSubagent({
			name: "child",
			description: "child",
			run: async () => ({ version: 1, taskId: "child" as never, text: "ok" }),
		});
		api.registerTuiOverlay({ name: "overlay", render: () => "overlay" });
		api.registerWeb({ entry: "./bundle.js", integrity: "sha256-abc", slots: ["app.sidebar"] });
		expect(api.commands).toHaveLength(1);
		expect(api.tools).toHaveLength(1);
		expect(api.subagents).toHaveLength(1);
		expect(api.tuiOverlays).toHaveLength(1);
		expect(api.web).toHaveLength(1);
		await api.dispose();
		await api.dispose();
		expect(api.commands).toHaveLength(0);
	});

	it("serves providers and jobs and tears down jobs with the host", async () => {
		const host = createExtensionHostServices({
			providers: [createFauxProvider([{ type: "completed", stopReason: "stop" }])],
			runJob: async (_input, options) => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				if (options.signal?.aborted) throw new Error("aborted");
				return { ok: true };
			},
		});
		expect(await host.providers.list()).toEqual([{ id: "faux", models: ["faux"] }]);
		const events = [];
		for await (const event of host.providers.request("faux", {
			requestId: "r" as never,
			model: "faux",
			messages: [],
			tools: [],
		}))
			events.push(event);
		expect(events).toHaveLength(1);
		const input: JobStartInput = { sessionId: "s" as SessionId, kind: "demo", input: null };
		const job = await host.jobs.start(input);
		expect((await job.result) as { ok: boolean }).toEqual({ ok: true });
		expect((await host.jobs.get(job.jobId)).state).toBe("completed");
		await host.lifecycle.dispose();
		await expect(host.providers.get("missing")).rejects.toThrow(/unavailable/);
	});

	it("rejects requests after lifecycle disposal", async () => {
		const host = createExtensionHostServices();
		await host.lifecycle.dispose();
		await expect(host.jobs.start({ sessionId: "s" as SessionId, kind: "x", input: null })).rejects.toThrow(/disposed/);
	});

	it("runs subprocesses with bounded output and timeout", async () => {
		const host = createExtensionHostServices();
		const result = await host.subprocess.run({
			command: process.execPath,
			args: ["-e", "process.stdout.write('ok')"],
			maxOutputBytes: 8,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ok");
		await expect(
			host.subprocess.run({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"] }, { timeoutMs: 5 }),
		).rejects.toThrow(/timed out/);
		await host.lifecycle.dispose();
	});
});
