import { describe, expect, it } from "vitest";
import { createRootContext, createServiceKey, type Fiber, type PluginDefinition } from "../src/index.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("runtime Context, Registry and Fiber behavior", () => {
	it("keeps services private until async apply activates", async () => {
		const root = createRootContext();
		const key = createServiceKey<number>("pending-service");
		const gate = deferred();
		const activation = root.plugin(
			{
				name: "pending-plugin",
				apply: async (context) => {
					context.set(key, 42);
					await gate.promise;
					return undefined;
				},
			} satisfies PluginDefinition<undefined>,
			undefined,
		);

		await Promise.resolve();
		expect(root.get(key)).toBeUndefined();
		gate.resolve();
		const fiber = await activation;
		expect(fiber.status).toBe("active");
		expect(root.get(key)).toBe(42);
		const entry = fiber.context.services.getEntry(key);
		expect(entry?.owner).toBe(fiber);
		await root.dispose();
	});

	it("rolls back every contribution when apply fails", async () => {
		const root = createRootContext();
		const key = createServiceKey<string>("rollback-service");
		let fiber: Fiber | undefined;
		await expect(
			root.plugin(
				{
					name: "broken-plugin",
					apply: (context, _config, owner) => {
						fiber = owner;
						context.set(key, "must-rollback");
						throw new Error("setup failed");
					},
				} satisfies PluginDefinition<undefined>,
				undefined,
			),
		).rejects.toThrow("setup failed");
		expect(fiber?.status).toBe("failed");
		expect(root.get(key)).toBeUndefined();
		await root.dispose();
	});

	it("validates plugin config before creating a Fiber", async () => {
		const root = createRootContext();
		let applied = false;
		await expect(
			root.plugin(
				{
					name: "validated-plugin",
					Config: {
						parse: (input) => {
							if (input !== "expected") throw new Error("invalid config");
							return input;
						},
					},
					apply: () => {
						applied = true;
					},
				} satisfies PluginDefinition<string>,
				"unexpected",
			),
		).rejects.toThrow("invalid config");
		expect(applied).toBe(false);
		await root.dispose();
	});

	it("isolates child services while normal children inherit", async () => {
		const root = createRootContext();
		const key = createServiceKey<string>("scope-service");
		root.set(key, "root");
		const inherited = root.child();
		const isolated = root.child({ isolate: true });
		expect(inherited.get(key)).toBe("root");
		expect(isolated.get(key)).toBeUndefined();

		await isolated.plugin(
			{
				name: "isolated-plugin",
				apply: (context) => {
					context.set(key, "session");
				},
			} satisfies PluginDefinition<undefined>,
			undefined,
		);
		expect(isolated.get(key)).toBe("session");
		expect(root.get(key)).toBe("root");
		expect(inherited.get(key)).toBe("root");
		await root.dispose();
	});

	it("rejects duplicate services in one scope", async () => {
		const root = createRootContext();
		const key = createServiceKey<boolean>("duplicate-service");
		await expect(
			root.plugin(
				{
					name: "duplicate-plugin",
					apply: (context) => {
						context.set(key, true);
						context.set(key, false);
					},
				} satisfies PluginDefinition<undefined>,
				undefined,
			),
		).rejects.toThrow(/Duplicate service registration/);
		expect(root.get(key)).toBeUndefined();
		await root.dispose();
	});

	it("disposes in reverse order, aggregates errors, and is idempotent", async () => {
		const root = createRootContext();
		const order: string[] = [];
		const fiber = await root.plugin(
			{
				name: "disposable-plugin",
				apply: (_context, _config, owner) => {
					owner.addDisposer(() => {
						order.push("first");
						throw new Error("first error");
					});
					owner.addDisposer(() => {
						order.push("second");
						throw new Error("second error");
					});
					return () => {
						order.push("returned");
						throw new Error("returned error");
					};
				},
			} satisfies PluginDefinition<undefined>,
			undefined,
		);

		const disposal = fiber.dispose();
		await expect(disposal).rejects.toBeInstanceOf(AggregateError);
		expect(order).toEqual(["returned", "second", "first"]);
		expect(fiber.status).toBe("disposed");
		await expect(fiber.dispose()).rejects.toBeInstanceOf(AggregateError);
		await expect(root.dispose()).resolves.toBeUndefined();
	});

	it("aborts pending setup and rejects late callbacks", async () => {
		const root = createRootContext();
		const key = createServiceKey<number>("late-service");
		const gate = deferred();
		let fiber: Fiber | undefined;
		let lateCallback: (() => void) | undefined;
		const activation = root.plugin(
			{
				name: "slow-plugin",
				apply: async (context, _config, owner) => {
					fiber = owner;
					lateCallback = () => context.set(key, 1);
					await gate.promise;
					return undefined;
				},
			} satisfies PluginDefinition<undefined>,
			undefined,
		);
		await Promise.resolve();
		const disposal = fiber?.dispose();
		expect(fiber?.signal.aborted).toBe(true);
		expect(() => lateCallback?.()).toThrow(/late service registration rejected/);
		gate.resolve();
		await expect(activation).resolves.toMatchObject({ status: "disposed" });
		await disposal;
		expect(root.get(key)).toBeUndefined();
		await root.dispose();
	});

	it("publishes lifecycle events without allowing observers to break activation", async () => {
		const root = createRootContext();
		const statuses: string[] = [];
		root.events.subscribe((event) => {
			if (event.type === "plugin_status") statuses.push(event.status);
			throw new Error("observer failure");
		});
		const fiber = await root.plugin(
			{
				name: "event-plugin",
				apply: () => undefined,
			} satisfies PluginDefinition<undefined>,
			undefined,
		);
		expect(statuses).toEqual(["loading", "active"]);
		await fiber.dispose();
		expect(statuses).toEqual(["loading", "active", "unloading", "disposed"]);
		await root.dispose();
	});
});
