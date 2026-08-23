import { describe, expect, it, vi } from "vitest";
import {
	CapabilityDeniedError,
	createCapabilityView,
	createDiagnosticSink,
	createFakeCapabilityView,
	createRootContext,
	EventBus,
} from "../src/index.ts";

describe("stage 3 event, diagnostics and capability boundaries", () => {
	it("orders observers by priority and stable registration order", async () => {
		const bus = new EventBus<{ value: number }>();
		const order: string[] = [];
		bus.subscribe(
			() => {
				order.push("low");
			},
			{ priority: 1 },
		);
		bus.subscribe(
			() => {
				order.push("high-a");
			},
			{ priority: 5 },
		);
		bus.subscribe(
			() => {
				order.push("high-b");
			},
			{ priority: 5 },
		);
		await bus.emit({ value: 1 });
		expect(order).toEqual(["high-a", "high-b", "low"]);
	});

	it("isolates observer failures, but critical handlers gate dispatch", async () => {
		const bus = new EventBus<{ value: number }>();
		const order: string[] = [];
		bus.subscribe(() => {
			order.push("observer");
			throw new Error("observer failed");
		});
		bus.subscribe(() => {
			order.push("after");
		});
		await expect(bus.emit({ value: 1 })).resolves.toMatchObject({ handled: 2, failures: [expect.any(Error)] });
		const critical = new EventBus<{ value: number }>();
		critical.subscribe(
			() => {
				throw new Error("gate failed");
			},
			{ critical: true },
		);
		critical.subscribe(() => {
			order.push("blocked");
		});
		await expect(critical.emit({ value: 1 })).rejects.toThrow("gate failed");
		expect(order).not.toContain("blocked");
	});

	it("supports timeout and abort, with automatic unsubscribe", async () => {
		const bus = new EventBus<{ value: number }>();
		const controller = new AbortController();
		const calls: string[] = [];
		bus.subscribe(
			async (_event, signal) => {
				calls.push("started");
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
			{ timeoutMs: 5, signal: controller.signal },
		);
		await expect(bus.emit({ value: 1 })).resolves.toMatchObject({ failures: [expect.any(Error)] });
		controller.abort();
		await expect(bus.emit({ value: 1 })).resolves.toMatchObject({ handled: 0 });
	});

	it("redacts handler credentials and rejects use after disposal", async () => {
		const records: string[] = [];
		const sink = createDiagnosticSink((record) => records.push(`${record.error?.message ?? record.message}`));
		const bus = new EventBus<{ value: number }>(sink);
		bus.subscribe(() => {
			throw new Error("authorization=Bearer-secret token=abc123");
		});
		await bus.emit({ value: 1 });
		expect(records.join(" ")).not.toContain("abc123");
		bus.dispose();
		await expect(bus.emit({ value: 1 })).rejects.toThrow("disposed");
		expect(() => bus.subscribe(() => undefined)).toThrow("disposed");
	});

	it("requires both project trust and declared capability", () => {
		const undeclared = createCapabilityView({ trustedProject: true, declared: {} });
		expect(() => undeclared.require("filesystem")).toThrow(CapabilityDeniedError);
		const untrusted = createCapabilityView({ trustedProject: false, declared: { filesystem: true } });
		expect(() => untrusted.require("filesystem")).toThrow(/untrusted/);
		const fake = createFakeCapabilityView({
			trustedProject: true,
			declared: { filesystem: true },
			values: { filesystem: "fake" },
		});
		expect(fake.get<string>("filesystem")).toBe("fake");
	});

	it("provides capability/logger views and rejects late registration after dispose", async () => {
		const report = vi.fn();
		const root = createRootContext({ trustedProject: false, diagnostics: createDiagnosticSink(report) });
		const fiber = await root.plugin(
			{
				name: "negative",
				capabilities: { filesystem: true },
				apply: (context) => {
					expect(() => context.capabilities.require("filesystem")).toThrow(/untrusted/);
					context.logger.error("secret=hidden", new Error("api_key=real"));
				},
			},
			undefined,
		);
		await fiber.dispose();
		expect(() => fiber.context.set(Symbol("late") as never, 1)).toThrow();
		await expect(root.dispose()).resolves.toBeUndefined();
		expect(JSON.stringify(report.mock.calls)).not.toContain("real");
	});
});
