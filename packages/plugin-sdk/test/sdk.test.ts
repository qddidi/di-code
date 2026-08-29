import { describe, expect, it } from "vitest";
import {
	createServiceKey,
	createSessionPluginFactory,
	getPluginDefinition,
	isRuntimeMode,
	PLUGIN_SDK_API_VERSION,
	PluginLifecycleError,
} from "../src/index.ts";

describe("plugin SDK root exports", () => {
	it("re-exports runtime and loader contracts", () => {
		expect(typeof createServiceKey).toBe("function");
		expect(isRuntimeMode("test")).toBe(true);
		expect(getPluginDefinition({ name: "sdk.fixture", apply: () => undefined }).name).toBe("sdk.fixture");
		expect(PLUGIN_SDK_API_VERSION).toBe(1);
	});

	it("isolates concurrent session scopes and disposes each scope exactly once", async () => {
		const disposed: string[] = [];
		const factory = createSessionPluginFactory((scope) => {
			scope.onDispose(() => {
				disposed.push(scope.sessionId);
			});
		});
		const [first, second] = await Promise.all([factory.create("one", undefined), factory.create("two", undefined)]);
		expect(first.sessionId).toBe("one");
		expect(second.sessionId).toBe("two");
		expect(first.signal).not.toBe(second.signal);
		await first.dispose();
		await first.dispose();
		expect(disposed).toEqual(["one"]);
		await factory.dispose();
		await factory.dispose();
		expect(disposed).toEqual(["one", "two"]);
		await expect(factory.create("three", undefined)).rejects.toBeInstanceOf(PluginLifecycleError);
	});

	it("rolls back a failed scope and preserves the factory for later sessions", async () => {
		const disposed: string[] = [];
		const factory = createSessionPluginFactory((scope, config: { readonly fail?: boolean }) => {
			scope.onDispose(() => {
				disposed.push(scope.sessionId);
			});
			if (config.fail) throw new Error("setup failed");
		});
		await expect(factory.create("bad", { fail: true })).rejects.toThrow("setup failed");
		expect(disposed).toEqual(["bad"]);
		const good = await factory.create("good", {});
		await good.dispose();
		expect(disposed).toEqual(["bad", "good"]);
		await factory.dispose();
	});
});
