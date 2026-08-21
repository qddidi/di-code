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
	limits: { timeoutMs, maxOutputBytes: 1024 },
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
});
