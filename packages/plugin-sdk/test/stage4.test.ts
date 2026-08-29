import { describe, expect, it } from "vitest";
import { createSessionEventRegistry, createSessionProjectionRegistry } from "../src/index.ts";

describe("typed Session events and projections", () => {
	it("validates, migrates, and replays events from a clean log", () => {
		const events = createSessionEventRegistry();
		events.register({
			namespace: "demo",
			eventName: "counter",
			schemaVersion: 2,
			validate: (payload) => typeof payload === "object" && payload !== null,
			migrate: (payload) => ({ value: (payload as { value?: number }).value ?? 0 }),
		});
		const projection = createSessionProjectionRegistry();
		projection.register({
			namespace: "demo",
			projectionName: "total",
			version: 1,
			initialState: 0,
			apply: (state, event) => state + (event.payload as { value: number }).value,
		});
		const migrated = events.migrate({
			namespace: "demo",
			eventName: "counter",
			schemaVersion: 1,
			payload: { value: 2 },
		});
		expect(migrated.schemaVersion).toBe(2);
		expect(
			projection.replay([
				migrated,
				{ namespace: "demo", eventName: "counter", schemaVersion: 2, payload: { value: 3 } },
			])[0]?.state,
		).toBe(5);
	});

	it("does not expose mutable registry snapshots", () => {
		const registry = createSessionEventRegistry();
		const dispose = registry.register({ namespace: "demo", eventName: "x", schemaVersion: 1, validate: () => true });
		expect(registry.snapshot()).toHaveLength(1);
		dispose();
		expect(registry.snapshot()).toHaveLength(0);
	});
});
