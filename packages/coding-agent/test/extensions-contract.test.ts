import { Type } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ExtensionReadOnlyTool } from "../src/index.ts";

const context: ExtensionContext = {
	cwd: "D:/sandbox/project",
	mode: "json",
	signal: undefined,
	isProjectTrusted: () => false,
	abort: () => {},
};

describe("extension API contract", () => {
	it("accepts a command, read-only tool, and typed event handler", async () => {
		const calls: string[] = [];
		const api: ExtensionAPI = {
			registerCommand(command) {
				calls.push(`command:${command.name}`);
			},
			registerTool(tool) {
				calls.push(`tool:${tool.name}`);
			},
			on(event) {
				calls.push(`event:${event}`);
			},
		};
		const schema = Type.Object({ path: Type.String() });
		const tool: ExtensionReadOnlyTool<typeof schema> = {
			name: "read-only",
			description: "Read one file through the host runtime",
			parameters: schema,
			execute: async (_id, parameters, _signal, receivedContext) => {
				expect(parameters.path).toBe("README.md");
				expect(receivedContext.isProjectTrusted()).toBe(false);
				return [{ type: "text", text: "fixture" }];
			},
		};
		api.registerCommand({ name: "hello", description: "Hello", handler: async () => {} });
		api.registerTool(tool);
		api.on("session_start", (event, receivedContext) => {
			expect(event.cwd).toBe(receivedContext.cwd);
		});
		await tool.execute("call-1", { path: "README.md" }, undefined, context);
		expect(calls).toEqual(["command:hello", "tool:read-only", "event:session_start"]);
	});

	it("keeps event payloads correlated with their event names", () => {
		const api: ExtensionAPI = {
			registerCommand: () => {},
			registerTool: () => {},
			on: () => {},
		};
		api.on("agent_start", (event) => expect(event.type).toBe("agent_start"));
		api.on("session_shutdown", (event) => expect(event.reason).toBe("error"));
	});

	it("allows a factory to initialize asynchronously", async () => {
		let initialized = false;
		const factory: ExtensionFactory = async (api) => {
			api.registerCommand({ name: "async", description: "Async", handler: async () => {} });
			initialized = true;
		};
		const api: ExtensionAPI = {
			registerCommand: () => {},
			registerTool: () => {},
			on: () => {},
		};
		await factory(api);
		expect(initialized).toBe(true);
	});
});
