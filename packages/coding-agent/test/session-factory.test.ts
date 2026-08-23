import { createFauxProvider } from "@di-code/ai";
import {
	agentSession,
	agentSessionKey,
	compactionBasic,
	contextBudget,
	networkCapability,
	processCapability,
	providerRegistry,
	systemPrompt,
	toolApproval,
	toolOutput,
	toolPolicy,
	toolRead,
	toolRegistry,
	workspace,
} from "@di-code/builtins";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { installAgentSessionFactory } from "../src/runtime/session-factory.ts";

describe("composition AgentSessionFactory", () => {
	it("uses the registered tool snapshot and releases the factory scope", async () => {
		const root = process.cwd();
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "write-1", name: "write", arguments: { path: "x.txt", content: "x" } }],
				},
				{ type: "success", content: [{ type: "text", text: "write is unavailable" }] },
			],
		});
		const context = createRootContext({ id: "session-factory", mode: "test", trustedProject: true });
		try {
			for (const definition of [providerRegistry, toolRegistry]) await context.plugin(definition, undefined);
			await context.plugin(workspace, { allowedRoot: root });
			for (const definition of [
				processCapability,
				networkCapability,
				toolApproval,
				toolPolicy,
				toolOutput,
				toolRead,
				contextBudget,
				compactionBasic,
				systemPrompt,
				agentSession,
			]) {
				await context.plugin(definition, undefined);
			}
			const removeFactory = installAgentSessionFactory(context);
			try {
				const session = await context.require(agentSessionKey).create({
					allowedRoot: root,
					provider: faux.provider,
					model: faux.model,
				});
				expect(session).toBeInstanceOf(AgentSession);
				if (!(session instanceof AgentSession)) throw new Error("Expected AgentSession");

				await session.prompt("write x.txt");
				expect(session.transcript.find((message) => message.role === "tool_result")).toMatchObject({
					toolName: "write",
					isError: true,
					content: [{ type: "text", text: "tool_unavailable: write" }],
				});
			} finally {
				await removeFactory();
			}
			expect(() =>
				context.require(agentSessionKey).create({ allowedRoot: root, provider: faux.provider, model: faux.model }),
			).toThrow("AgentSession factory is not registered");
		} finally {
			await context.dispose();
		}
	});
});
