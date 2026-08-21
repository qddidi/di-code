import { describe, expect, it } from "vitest";
import {
	missingInteractiveFrontendCapabilities,
	PluginHost,
	parsePluginManifest,
	REQUIRED_INTERACTIVE_FRONTEND_CAPABILITIES,
} from "../src/index.ts";

describe("plugin runtime package boundary", () => {
	it("defines and validates the core interactive frontend capability contract", () => {
		expect(REQUIRED_INTERACTIVE_FRONTEND_CAPABILITIES).toContain("multiline-input");
		expect(missingInteractiveFrontendCapabilities(["streaming"])).toEqual(
			expect.arrayContaining(["multiline-input", "tool-status", "compaction"]),
		);
		expect(missingInteractiveFrontendCapabilities(REQUIRED_INTERACTIVE_FRONTEND_CAPABILITIES)).toEqual([]);
	});
	it("atomically commits contributions and releases them in reverse order", async () => {
		const host = new PluginHost({ reservedCommands: ["help"] });
		const order: string[] = [];
		const scope = await host.load("demo", (api) => {
			api.registerTool({
				name: "demo__echo",
				description: "echo",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async () => [{ type: "text", text: "ok" }],
			} as never);
			api.effect(() => ({
				dispose: () => {
					order.push("effect");
				},
			}));
			api.registerCommand({ name: "demo", description: "demo", handler: async () => {} });
		});
		expect(host.snapshot().contributions.tools).toHaveLength(1);
		expect(scope.state).toBe("active");
		await host.unload("demo");
		expect(order).toEqual(["effect"]);
		expect(host.snapshot().contributions.tools).toHaveLength(0);
	});

	it("does not publish partial registrations when validation fails", async () => {
		const host = new PluginHost();
		await expect(
			host.load("bad", (api) => {
				api.registerTool({ name: "bad__ok", description: "ok", parameters: {}, execute: async () => [] } as never);
				api.registerTool({ name: "wrong", description: "wrong", parameters: {}, execute: async () => [] } as never);
			}),
		).rejects.toThrow("namespace");
		expect(host.snapshot().contributions.tools).toHaveLength(0);
	});

	it("keeps other plugin contributions active when one scope is unloaded", async () => {
		const host = new PluginHost();
		await host.load("first", (api) => {
			api.registerTool({ name: "first__tool", description: "first", parameters: {}, execute: async () => [] } as never);
		});
		await host.load("second", (api) => {
			api.registerTool({
				name: "second__tool",
				description: "second",
				parameters: {},
				execute: async () => [],
			} as never);
		});
		await host.unload("first");
		expect(host.snapshot().contributions.tools.map((tool) => tool.name)).toEqual(["second__tool"]);
	});

	it("removes an individual contribution through its disposer", async () => {
		const host = new PluginHost();
		let remove!: { dispose(): void };
		await host.load("disposable", (api) => {
			remove = api.registerCommand({ name: "disposable", description: "disposable", handler: async () => {} });
		});
		expect(host.snapshot().contributions.commands).toHaveLength(1);
		remove.dispose();
		expect(host.snapshot().contributions.commands).toHaveLength(0);
	});

	it("resolves prompt sections and snapshots tools per request", async () => {
		const host = new PluginHost({ baseSystemPrompt: "base" });
		await host.load("prompt", (api) => {
			api.registerPromptSection({ id: "one", order: 1, render: () => "section" });
		});
		const context = await host.getContextProvider().resolve();
		expect(context.systemPrompt).toBe("base\n\nsection");
		expect(context.tools).toEqual([]);
	});

	it("keeps prompt rendering and contributions from the same request snapshot", async () => {
		const host = new PluginHost();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		await host.load("stable", (api) => {
			api.registerTool({
				name: "stable__tool",
				description: "stable",
				parameters: {},
				execute: async () => [],
			} as never);
			api.registerPromptSection({
				id: "wait",
				order: 1,
				render: async () => {
					await blocked;
					return "stable";
				},
			});
		});
		const resolving = host.getContextProvider().resolve();
		await host.unload("stable");
		release();
		const context = await resolving;
		expect(context.systemPrompt).toBe("stable");
		expect(context.tools.map((tool) => tool.name)).toEqual(["stable__tool"]);
	});

	it("validates apiVersion and required manifest fields", () => {
		expect(
			parsePluginManifest({
				apiVersion: 1,
				id: "demo",
				name: "Demo",
				version: "1.0.0",
				entry: "./index.js",
				permissions: { filesystem: "none", network: [], process: [] },
			}).id,
		).toBe("demo");
		expect(() => parsePluginManifest({ apiVersion: 2 })).toThrow("API version");
		expect(() =>
			parsePluginManifest({
				apiVersion: 1,
				id: "demo",
				name: "Demo",
				version: "1.0.0",
				entry: "../index.js",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		).toThrow("relative");
	});

	it("rejects concurrent loads for the same plugin id", async () => {
		const host = new PluginHost();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = host.load("same", async () => {
			await blocked;
		});
		await expect(host.load("same", () => {})).rejects.toThrow("already loaded");
		release();
		await first;
	});

	it("disposes resources in reverse order, is idempotent, and aggregates failures", async () => {
		const host = new PluginHost();
		const order: string[] = [];
		const scope = await host.load("cleanup", (api) => {
			api.effect(() => ({
				dispose: async () => {
					order.push("first");
					throw new Error("first failed");
				},
			}));
			api.effect(() => ({
				dispose: () => {
					order.push("second");
					throw new Error("second failed");
				},
			}));
		});
		await expect(scope.dispose()).rejects.toMatchObject({ name: "AggregateError" });
		await expect(scope.dispose()).rejects.toMatchObject({ name: "AggregateError" });
		expect(order).toEqual(["second", "first"]);
		expect(scope.state).toBe("stopped");
	});

	it("keeps handler ownership in diagnostics and rejects duplicate contribution ids", async () => {
		const host = new PluginHost();
		await host.load("events", (api) => {
			api.on("test", () => {
				throw new Error("handler failed");
			});
		});
		await host.emit("test", {});
		expect(host.diagnostics.at(-1)).toMatchObject({ pluginId: "events", stage: "handler" });
		await expect(
			host.load("duplicate", (api) => {
				api.registerInteractiveFrontend({
					id: "same",
					displayName: "one",
					capabilities: [],
					create: () => ({ start: async () => {}, dispose: async () => {} }),
				});
			}),
		).resolves.toBeDefined();
		await expect(
			host.load("duplicate-two", (api) => {
				api.registerInteractiveFrontend({
					id: "same",
					displayName: "two",
					capabilities: [],
					create: () => ({ start: async () => {}, dispose: async () => {} }),
				});
			}),
		).rejects.toThrow("frontend conflict");
	});

	it("exposes restricted panel data and pure tool result renderers in contribution snapshots", async () => {
		const host = new PluginHost();
		await host.load("ui", (api) => {
			api.registerInteractivePanel({ id: "ui-status", title: "Status", data: { ready: true } });
			api.registerToolDetailRenderer({ toolName: "ui__inspect", render: (result) => JSON.stringify(result) });
		});
		const { panels, toolDetailRenderers } = host.snapshot().contributions;
		expect(panels).toEqual([{ id: "ui-status", title: "Status", data: { ready: true } }]);
		expect(toolDetailRenderers[0]?.render({ ok: true })).toBe('{"ok":true}');
	});
});
