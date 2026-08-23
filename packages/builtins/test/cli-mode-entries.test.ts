import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	cliParser,
	commandCore,
	commandModel,
	commandRegistryKey,
	commandSession,
	createBuiltinCommandRegistry,
	modeJson,
	modeRegistryKey,
	outputJson,
	rendererRegistryKey,
	theme,
	themeRegistryKey,
} from "../src/index.ts";

describe("CLI and output composition", () => {
	it("keeps command contributions owner-scoped and generates registry help", async () => {
		const context = createRootContext({ id: "commands" });
		try {
			await context.plugin(commandCore, undefined);
			await context.plugin(commandSession, undefined);
			await context.plugin(commandModel, undefined);
			const registry = context.require(commandRegistryKey);
			expect(registry.list().map((command) => command.name)).toEqual(["login", "logout", "model", "session", "tree"]);
			expect(registry.help("en")).toContain("/model");
			await context.dispose();
			expect(context.get(commandRegistryKey)).toBeUndefined();
		} finally {
			await context.dispose();
		}
	});

	it("registers JSON mode and renderer through the same composition context", async () => {
		const context = createRootContext({ id: "modes", mode: "json" });
		try {
			await context.plugin(commandCore, undefined);
			await context.plugin(cliParser, undefined);
			await context.plugin(modeJson, undefined);
			await context.plugin(outputJson, undefined);
			await context.plugin(theme, undefined);
			expect(
				context
					.require(modeRegistryKey)
					.list()
					.map((mode) => mode.name),
			).toEqual(["json"]);
			expect(context.require(rendererRegistryKey).find("json")?.render({ type: "agent_end" })).toContain('"version":2');
			expect(
				context
					.require(themeRegistryKey)
					.list()
					.map((entry) => entry.name),
			).toEqual(["dark", "light"]);
		} finally {
			await context.dispose();
		}
	});

	it("provides a standalone command registry for legacy interactive hosts", async () => {
		const registry = createBuiltinCommandRegistry();
		const calls: string[] = [];
		await registry.execute("clear", { args: "", host: { runCommand: (name: string) => calls.push(name) } });
		expect(calls).toEqual(["clear"]);
	});
});
