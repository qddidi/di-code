import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicPluginBroker } from "../src/plugins/dynamic-broker.ts";

const definition = (source: string, pluginId = "session-plugin", timeoutMs = 1_000) => ({
	pluginId,
	version: "1.0.0",
	runtimeVersion: "1",
	source,
	capabilities: ["tools"],
	limits: { timeoutMs, maxOutputBytes: 16_384 },
});

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("DynamicPluginBroker", () => {
	const brokers: DynamicPluginBroker[] = [];
	let cwd: string;

	afterEach(async () => {
		for (const broker of brokers.splice(0)) await broker.dispose();
		if (cwd) await rm(cwd, { recursive: true, force: true });
	});

	async function create(options: Omit<ConstructorParameters<typeof DynamicPluginBroker>[0], "cwd">) {
		cwd = await mkdtemp(join(tmpdir(), "di-code-dynamic-"));
		const broker = new DynamicPluginBroker({ ...options, cwd });
		brokers.push(broker);
		return broker;
	}

	it("rejects execution outside interactive mode and without approval", async () => {
		const broker = await create({
			mode: "print",
			allowDynamicPlugins: true,
			confirmRun: vi.fn().mockResolvedValue(true),
		});
		const pkg = broker.define(definition("export default {}"));
		await expect(broker.run(pkg.id)).rejects.toThrow("interactive mode");
	});

	it("rejects an already-cancelled run before approval or child spawn", async () => {
		const confirmRun = vi.fn().mockResolvedValue(true);
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun });
		const pkg = broker.define(definition("export default {}"));
		const controller = new AbortController();
		controller.abort();
		await expect(broker.run(pkg.id, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(confirmRun).not.toHaveBeenCalled();
		expect(broker.inspect().runs).toHaveLength(0);
	});

	it("runs source in a child process only after explicit approval and stops idempotently", async () => {
		const confirmRun = vi.fn().mockResolvedValue(true);
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun });
		const pkg = broker.define(definition("export default (api) => { if (!api) throw new Error('missing api'); }"));
		const started = await broker.run(pkg.id);
		expect(started.state).toBe("active");
		expect(confirmRun).toHaveBeenCalledWith(
			expect.objectContaining({ pluginId: "session-plugin", impact: "executes-session-code" }),
		);
		const stopped = await broker.stop(started.id);
		expect(stopped.state).toBe("stopped");
		expect(await broker.stop(started.id)).toMatchObject({ id: started.id, state: "stopped" });
	});

	it("rolls back an update when the replacement child fails", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const old = broker.define(definition("export default {}"));
		const active = await broker.run(old.id);
		const bad = definition("throw new Error('replacement failed')");
		await expect(broker.update(bad)).rejects.toThrow("replacement failed");
		expect(broker.inspect().runs.find((run) => run.id === active.id)?.state).toBe("active");
		await broker.stop(active.id);
	});

	it("cancels a pending child run through AbortSignal", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const pkg = broker.define(definition("await new Promise(() => {});", "cancel-plugin"));
		const controller = new AbortController();
		const pending = broker.run(pkg.id, controller.signal);
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(broker.inspect().runs).toEqual(expect.arrayContaining([expect.objectContaining({ state: "stopped" })]));
	});

	it("fails on timeout, child crash, and invalid stdout protocol", async () => {
		const diagnostics: string[] = [];
		const broker = await create({
			mode: "interactive",
			allowDynamicPlugins: true,
			confirmRun: async () => true,
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.stage),
		});
		const timeout = broker.define(definition("await new Promise(() => {});", "timeout-plugin", 20));
		await expect(broker.run(timeout.id)).rejects.toThrow("timed out");
		const crash = broker.define(definition("throw new Error('crashed')", "crash-plugin"));
		await expect(broker.run(crash.id)).rejects.toThrow("crashed");
		const protocol = broker.define(definition("console.log('not-json'); export default {};", "protocol-plugin"));
		await expect(broker.run(protocol.id)).rejects.toThrow("protocol");
		expect(diagnostics).toEqual(expect.arrayContaining(["timeout", "exit", "protocol"]));
	});

	it("fails and removes a run that times out after becoming active", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const pkg = broker.define(definition("export default {};", "active-timeout-plugin", 200));
		const started = await broker.run(pkg.id);
		expect(started.state).toBe("active");
		await delay(260);
		const run = broker.inspect().runs.find((candidate) => candidate.id === started.id);
		expect(run).toMatchObject({ state: "failed", failure: "Dynamic plugin run timed out." });
	});

	it("normalizes unexpected zero exit and redacts child errors", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const zeroExit = broker.define(
			definition("export default {}; setTimeout(() => process.exit(0), 10);", "zero-exit-plugin"),
		);
		const started = await broker.run(zeroExit.id);
		await delay(200);
		expect(broker.inspect().runs.find((candidate) => candidate.id === started.id)).toMatchObject({ state: "failed" });
		const secret = broker.define(definition("throw new Error('token=super-secret')", "redaction-plugin"));
		await expect(broker.run(secret.id)).rejects.not.toThrow("super-secret");
	});

	it("enforces the package output byte limit", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const limited = broker.define({
			...definition('console.log("x".repeat(2000)); export default {};', "output-plugin"),
			limits: { timeoutMs: 1000, maxOutputBytes: 64 },
		});
		await expect(broker.run(limited.id)).rejects.toThrow("output exceeds 64 bytes");
	});

	it("registers and revokes namespaced child capabilities", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const pkg = broker.define(
			definition(
				"export default (api) => api.registerTool({ name: 'capability-plugin__echo', description: 'echo', parameters: { type: 'object', properties: {}, additionalProperties: false } });",
				"capability-plugin",
			),
		);
		const run = await broker.run(pkg.id);
		expect(run.capabilities).toEqual([expect.objectContaining({ type: "tool", name: "capability-plugin__echo" })]);
		await broker.stop(run.id);
		expect(broker.inspect().runs.find((candidate) => candidate.id === run.id)?.capabilities).toEqual([]);
	});

	it("fails and cleans up duplicate child capability registrations", async () => {
		const diagnostics: string[] = [];
		const broker = await create({
			mode: "interactive",
			allowDynamicPlugins: true,
			confirmRun: async () => true,
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.stage),
		});
		const pkg = broker.define(
			definition(
				"export default (api) => { const tool = { name: 'duplicate-plugin__echo', description: 'echo', parameters: { type: 'object', properties: {}, additionalProperties: false } }; api.registerTool(tool); api.registerTool(tool); }",
				"duplicate-plugin",
			),
		);
		await expect(broker.run(pkg.id)).rejects.toThrow("Capability already registered");
		expect(diagnostics).toContain("protocol");
		expect(broker.inspect().runs[0]?.capabilities).toEqual([]);
	});

	it("executes dynamic tools, renders prompts, wraps middleware, and receives events", async () => {
		const broker = await create({
			mode: "interactive",
			allowDynamicPlugins: true,
			model: "test-model",
			confirmRun: async () => true,
		});
		const pkg = broker.define({
			...definition(
				`export default (api) => {
					let observed = false;
					api.registerTool({ name: 'bridge-plugin__echo', description: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, execute: async (_id, args, signal, ctx) => [{ type: 'text', text: (observed ? 'event:' : '') + ctx.model + ':' + args.value }] });
					api.registerPromptSection({ id: 'prompt', order: 1, render: (ctx) => 'cwd=' + ctx.cwd + ';model=' + ctx.model });
					api.useToolMiddleware({ id: 'middleware', execute: async (execution, next) => { const result = await next(execution); return [{ type: 'text', text: 'wrapped:' + result[0].text }]; } });
					api.on('session_start', async () => { observed = true; });
				}`,
				"bridge-plugin",
			),
			capabilities: ["tools", "prompts", "middleware", "events"],
		});
		const run = await broker.run(pkg.id);
		const provider = broker.getContextProvider();
		const context = await provider.resolve();
		expect(context.systemPrompt).toContain("model=test-model");
		const tool = context.tools.find((candidate) => candidate.name === "bridge-plugin__echo");
		expect(tool).toBeDefined();
		const middleware = context.toolMiddleware?.[0];
		if (!tool || !middleware) throw new Error("dynamic capability bridge was not registered");
		const executeThroughMiddleware = (value: string) =>
			middleware({ toolCallId: "call", tool, parameters: { value } }, async (execution) =>
				tool.execute(execution.toolCallId, execution.parameters),
			);
		const first = await executeThroughMiddleware("one");
		expect(first).toEqual([{ type: "text", text: "wrapped:test-model:one" }]);
		await broker.emit({ type: "session_start" });
		const second = await executeThroughMiddleware("two");
		expect(second).toEqual([{ type: "text", text: "wrapped:event:test-model:two" }]);
		await broker.stop(run.id);
		expect((await broker.getContextProvider().resolve()).tools).toHaveLength(0);
	});

	it("replays session_start to a run activated after the session began", async () => {
		const broker = await create({
			mode: "interactive",
			allowDynamicPlugins: true,
			confirmRun: async () => true,
		});
		await broker.emit({ type: "session_start", cwd });
		const pkg = broker.define({
			...definition(
				`export default (api) => {
					let observedCwd = '';
					api.on('session_start', (event) => { observedCwd = event.cwd; });
					api.registerTool({ name: 'late-plugin__observed', description: 'observed', parameters: { type: 'object' }, execute: async () => [{ type: 'text', text: observedCwd }] });
				}`,
				"late-plugin",
			),
			capabilities: ["tools", "events"],
		});
		const run = await broker.run(pkg.id);
		const context = await broker.getContextProvider().resolve();
		const tool = context.tools.find((candidate) => candidate.name === "late-plugin__observed");
		if (!tool) throw new Error("late dynamic tool was not registered");
		expect(await tool.execute("call", {})).toEqual([{ type: "text", text: cwd }]);
		await broker.stop(run.id);
	});

	it("propagates cancellation into a dynamic invocation", async () => {
		const broker = await create({ mode: "interactive", allowDynamicPlugins: true, confirmRun: async () => true });
		const pkg = broker.define({
			...definition(
				"export default (api) => api.registerTool({ name: 'cancel-bridge__wait', description: 'wait', parameters: { type: 'object' }, execute: async (_id, _args, signal) => { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('child cancelled')), { once: true }); }); return [{ type: 'text', text: 'done' }]; } });",
				"cancel-bridge",
			),
		});
		const run = await broker.run(pkg.id);
		const context = await broker.getContextProvider().resolve();
		const controller = new AbortController();
		const tool = context.tools[0];
		const pending = tool.execute("call", {}, controller.signal);
		void pending.catch(() => undefined);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await broker.stop(run.id);
	});
});
