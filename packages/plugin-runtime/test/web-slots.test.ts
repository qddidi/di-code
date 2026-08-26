import { describe, expect, it } from "vitest";
import { type RegistryOwner, validateWebManifest, WebSlotRegistry, type WebSlotRegistryError } from "../src/index.ts";

const owner: RegistryOwner = { fiberId: "web-test", pluginName: "web-test" };
const contribution = (id: string, order: number, slot: string = "app.sidebar") => ({
	id,
	slot,
	version: 1 as const,
	order,
	componentKey: "builtin.workspace-status",
});

describe("WebSlotRegistry", () => {
	it("ignores unknown slots for forward compatibility and keeps stable order", () => {
		const registry = new WebSlotRegistry();
		registry.register(contribution("late", 20), owner);
		registry.register(contribution("first", 10), owner);
		registry.register(contribution("same-order", 10), owner);
		const unknown = registry.register(contribution("future", 0, "conversation.future"), owner);
		unknown();
		expect(registry.list("app.sidebar").map((entry) => entry.id)).toEqual(["first", "same-order", "late"]);
		expect(registry.snapshot()).toHaveLength(3);
	});

	it("rejects duplicate IDs, enforces capabilities, and disposes idempotently", () => {
		const registry = new WebSlotRegistry();
		const dispose = registry.register(contribution("one", 0), owner);
		expect(() => registry.register(contribution("one", 1), owner)).toThrowError(
			expect.objectContaining<Partial<WebSlotRegistryError>>({ code: "duplicate" }),
		);
		expect(() => registry.register(contribution("one", 1, "settings.panel"), owner)).toThrowError(
			expect.objectContaining<Partial<WebSlotRegistryError>>({ code: "duplicate" }),
		);
		expect(() =>
			registry.register({ ...contribution("secure", 0), capability: "settings.read" }, owner, new Set(["ui"])),
		).toThrowError(expect.objectContaining<Partial<WebSlotRegistryError>>({ code: "capability" }));
		dispose();
		dispose();
		expect(registry.snapshot()).toHaveLength(0);
	});
});

describe("Web manifest validation", () => {
	it("accepts versioned declarations and rejects unsafe bundle metadata", () => {
		expect(
			validateWebManifest({
				protocolVersion: 1,
				contributions: [contribution("ok", 0)],
				bundle: { source: "builtin", csp: "default-src 'self'" },
			}),
		).toBe(true);
		expect(
			validateWebManifest({
				protocolVersion: 1,
				contributions: [],
				bundle: { source: "managed", path: "../escape", sha256: "bad" },
			}),
		).toBe(false);
	});
});
