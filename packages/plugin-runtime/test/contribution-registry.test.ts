import { describe, expect, it } from "vitest";
import {
	assertProviderModel,
	assertRpcMethodContribution,
	assertToolSchema,
	ContributionRegistry,
	type ContributionRegistryError,
	type RegistryOwner,
} from "../src/index.ts";

const owner: RegistryOwner = { fiberId: "fiber-1", pluginName: "test-plugin" };

describe("ContributionRegistry", () => {
	it("registers contributions and returns an idempotent owner disposer", () => {
		const registry = new ContributionRegistry();
		const dispose = registry.register(
			{ kind: "tool", name: "read", schema: { type: "object", properties: {} }, execute: () => "ok" },
			owner,
		);
		expect(registry.list("tool")).toHaveLength(1);
		dispose();
		dispose();
		expect(registry.list("tool")).toHaveLength(0);
	});

	it("rejects duplicates, namespace conflicts and reserved names", () => {
		const registry = new ContributionRegistry({ reserved: ["help"] });
		registry.register({ kind: "command", name: "build", run: () => undefined }, owner);
		expect(() => registry.register({ kind: "command", name: "build", run: () => undefined }, owner)).toThrowError(
			expect.objectContaining<Partial<ContributionRegistryError>>({ code: "duplicate" }),
		);
		expect(() =>
			registry.register({ kind: "tool", name: "build", schema: { type: "object" }, execute: () => undefined }, owner),
		).toThrowError(expect.objectContaining<Partial<ContributionRegistryError>>({ code: "namespace-conflict" }));
		expect(() => registry.register({ kind: "command", name: "help", run: () => undefined }, owner)).toThrowError(
			expect.objectContaining<Partial<ContributionRegistryError>>({ code: "reserved" }),
		);
	});

	it("returns immutable deterministic snapshots", () => {
		const registry = new ContributionRegistry();
		registry.register({ kind: "resource", name: "zeta", uri: "resource:z", read: () => "z" }, owner);
		registry.register({ kind: "command", namespace: "plugin", name: "alpha", run: () => undefined }, owner);
		registry.register({ kind: "provider", name: "alpha", models: [{ id: "model-a" }] }, owner);
		const snapshot = registry.snapshot();
		expect(snapshot.entries.map((entry) => `${entry.kind}:${entry.namespace ?? ""}:${entry.name}`)).toEqual([
			"provider::alpha",
			"command:plugin:alpha",
			"resource::zeta",
		]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.entries)).toBe(true);
	});
});

describe("contribution boundary validators", () => {
	it("validates tool schemas, RPC methods and provider models", () => {
		assertToolSchema({ type: "object", properties: { path: { type: "string" } } });
		assertProviderModel({ id: "model-a", contextWindow: 1000, maxTokens: 100 });
		assertRpcMethodContribution({
			kind: "rpc-method",
			name: "get_state",
			params: { type: "object" },
			handle: () => undefined,
		});
		expect(() => assertToolSchema({ type: "array" })).toThrow();
		expect(() => assertProviderModel({ id: "model-a", contextWindow: 0 })).toThrow();
		expect(() =>
			assertRpcMethodContribution({ kind: "rpc-method", name: "bad name", handle: () => undefined }),
		).toThrow();
	});
});
