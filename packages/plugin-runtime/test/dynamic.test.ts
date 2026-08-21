import { describe, expect, it } from "vitest";
import {
	ActiveRun,
	DYNAMIC_PLUGIN_PROTOCOL_VERSION,
	DynamicPluginRuntime,
	Package,
	parseDynamicPluginCapabilityJsonl,
	parseDynamicPluginCapabilityRecord,
	parseDynamicPluginJsonl,
	parseDynamicPluginJsonlRecord,
	parseDynamicPluginRequest,
	parseDynamicPluginResponse,
	stringifyDynamicPluginCapabilityJsonl,
	stringifyDynamicPluginJsonl,
} from "../src/index.ts";

const definition = {
	pluginId: "temporary-tools",
	version: "1.0.0",
	runtimeVersion: "1",
	source: "export default {}",
	capabilities: ["tools"],
} as const;

describe("dynamic plugin runtime protocol", () => {
	it("creates immutable package metadata without executing source", () => {
		const runtime = new DynamicPluginRuntime();
		const pkg = runtime.define(definition, 10);
		expect(pkg).toBeInstanceOf(Package);
		expect(Object.isFrozen(pkg)).toBe(true);
		expect(pkg.snapshot()).toMatchObject({ id: "pkg-1", pluginId: "temporary-tools", sourceBytes: 17, createdAt: 10 });
		expect(pkg.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(runtime.listPackages()).toHaveLength(1);
	});

	it("enforces ActiveRun transitions and repeated stop is harmless", () => {
		const pkg = new Package("pkg-test", definition, 1);
		const run = new ActiveRun("run-test", pkg, 2);
		expect(run.state).toBe("starting");
		run.activate();
		run.beginStop();
		run.stop(3);
		run.stop(4);
		expect(run.snapshot()).toMatchObject({ state: "stopped", stoppedAt: 3 });
		expect(() => run.activate()).toThrow("Invalid active run transition");
	});

	it("handles define, run and stop JSONL operations", () => {
		const runtime = new DynamicPluginRuntime();
		const defined = runtime.handle(
			parseDynamicPluginRequest({ version: 1, id: "d", method: "plugin_define", params: definition }),
		);
		expect(defined).toMatchObject({ version: 1, id: "d", ok: true });
		const packageId = (defined as { result: { id: string } }).result.id;
		const started = runtime.handle({ version: 1, id: "r", method: "plugin_run", params: { packageId } });
		const runId = (started as { result: { id: string } }).result.id;
		const stopped = runtime.handle({ version: 1, id: "s", method: "plugin_stop", params: { runId } });
		expect(stopped).toMatchObject({ ok: true, result: { state: "stopped" } });
		const line = stringifyDynamicPluginJsonl({ version: 1, id: "x", method: "plugin_stop", params: { runId } });
		expect(line.endsWith("\n")).toBe(true);
		expect(parseDynamicPluginJsonl(line)).toMatchObject({ method: "plugin_stop", params: { runId } });
		const response = parseDynamicPluginResponse(stopped);
		expect(parseDynamicPluginJsonlRecord(stringifyDynamicPluginJsonl(response))).toMatchObject({ ok: true });
	});

	it("rejects malformed, oversized and unsafe requests", () => {
		expect(() => parseDynamicPluginJsonl("not json")).toThrow("invalid dynamic plugin JSONL");
		expect(() =>
			parseDynamicPluginRequest({ version: 2, id: "x", method: "plugin_stop", params: { runId: "r" } }),
		).toThrow("protocol version");
		expect(() =>
			parseDynamicPluginRequest({
				version: 1,
				id: "x",
				method: "plugin_define",
				params: { ...definition, pluginId: "../escape" },
			}),
		).toThrow("hyphenated");
		expect(() =>
			parseDynamicPluginRequest({
				version: 1,
				id: "x",
				method: "plugin_define",
				params: { ...definition, source: "x".repeat(1_048_577) },
			}),
		).toThrow("exceeds");
	});

	it("does not remove packages while a run is active and cleans terminal runs", () => {
		const runtime = new DynamicPluginRuntime();
		const pkg = runtime.define(definition);
		const run = runtime.startRun(pkg.id);
		expect(() => runtime.remove(pkg.id)).toThrow("active run");
		runtime.stop(run.id);
		runtime.remove(pkg.id);
		expect(runtime.inspect()).toEqual({ packages: [], runs: [] });
	});

	it("returns redacted protocol errors for unknown resources", () => {
		const runtime = new DynamicPluginRuntime();
		const response = runtime.handle({
			version: DYNAMIC_PLUGIN_PROTOCOL_VERSION,
			id: "x",
			method: "plugin_stop",
			params: { runId: "missing" },
		});
		expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	it("validates capability registration and revocation records", () => {
		const registration = {
			version: 1 as const,
			id: "cap-1",
			method: "capability_register" as const,
			params: {
				runId: "run-1",
				pluginId: "temporary-tools",
				capability: {
					type: "tool" as const,
					id: "temporary-tools__echo",
					name: "temporary-tools__echo",
					description: "echo",
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			},
		};
		const line = stringifyDynamicPluginCapabilityJsonl(registration);
		expect(parseDynamicPluginCapabilityJsonl(line)).toEqual(registration);
		expect(parseDynamicPluginJsonlRecord(stringifyDynamicPluginJsonl(registration))).toEqual(registration);
		const runtime = new DynamicPluginRuntime();
		const pkg = runtime.define(definition);
		const run = runtime.startRun(pkg.id);
		runtime.activateRun(run.id);
		runtime.registerCapability(run.id, registration.params.capability);
		expect(runtime.getRun(run.id)?.snapshot().capabilities).toEqual([registration.params.capability]);
		runtime.revokeCapability(run.id, registration.params.capability.id);
		expect(runtime.getRun(run.id)?.snapshot().capabilities).toEqual([]);
		expect(() =>
			parseDynamicPluginCapabilityRecord({
				...registration,
				params: { ...registration.params, capability: { ...registration.params.capability, name: "wrong" } },
			}),
		).toThrow("namespace");
	});
});
