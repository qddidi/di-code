import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import {
	agentSession,
	agentSessionKey,
	compactionBasic,
	compactionRegistryKey,
	compactionToolResult,
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
import { createSessionPluginFactory, sessionPluginRegistryKey } from "@di-code/plugin-sdk";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession } from "../src/core/session.ts";
import { installAgentSessionFactory } from "../src/runtime/session-factory.ts";

describe("composition AgentSessionFactory", () => {
	it("lets a Session plugin switch its prompt section from the Session snapshot", async () => {
		const root = process.cwd();
		let mode = "normal";
		let generated = 0;
		const prompts: string[] = [];
		const plugin = createSessionPluginFactory((scope) => {
			scope.promptSections.register({
				name: "test.mode",
				order: 10,
				owner: "test-plugin",
				generate: ({ session }) => {
					generated += 1;
					return (session as { readonly mode: string }).mode;
				},
			});
		});
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "one" }] },
				{ type: "success", content: [{ type: "text", text: "two" }] },
				{ type: "success", content: [{ type: "text", text: "three" }] },
			],
		});
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				request: Parameters<typeof faux.provider.stream>[1],
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				prompts.push(request.systemPrompt ?? "");
				return faux.provider.stream(model, request, options);
			},
		};
		const context = createRootContext({ id: "session-prompt-plugin", mode: "test", trustedProject: true });
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
			])
				await context.plugin(definition, undefined);
			const removeFactory = installAgentSessionFactory(context);
			try {
				const session = (await context.require(agentSessionKey).create({
					allowedRoot: root,
					provider,
					model: faux.model,
					sessionPlugins: [{ factory: plugin, config: undefined }],
					getPromptSnapshot: () => ({ mode }),
				})) as AgentSession;
				await session.prompt("first");
				mode = "plan";
				await session.prompt("second");
				await plugin.dispose();
				await session.prompt("third");
				await session.dispose();
				expect(generated).toBe(2);
				expect(prompts).toEqual(["normal", "plan", ""]);
			} finally {
				await removeFactory();
			}
		} finally {
			await context.dispose();
		}
	});
	it("creates isolated Session plugin scopes and cleans them on session disposal and factory unload", async () => {
		const root = process.cwd();
		const seen: string[] = [];
		const factory = createSessionPluginFactory((scope) => {
			seen.push(scope.sessionId);
			scope.onDispose(() => {
				seen.push(`disposed:${scope.sessionId}`);
			});
		});
		const context = createRootContext({ id: "session-plugin-factory", mode: "test", trustedProject: true });
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
			])
				await context.plugin(definition, undefined);
			const removeFactory = installAgentSessionFactory(context);
			const registrationDispose = context
				.require(sessionPluginRegistryKey)
				.register({ name: "test.scope", factory, config: undefined });
			const faux = createFauxProvider({ responses: [] });
			const first = (await context
				.require(agentSessionKey)
				.create({ allowedRoot: root, provider: faux.provider, model: faux.model })) as AgentSession;
			const second = (await context
				.require(agentSessionKey)
				.create({ allowedRoot: root, provider: faux.provider, model: faux.model })) as AgentSession;
			await first.dispose();
			expect(seen.filter((value) => value.startsWith("disposed:")).length).toBe(1);
			await second.dispose();
			await registrationDispose();
			await removeFactory();
			expect(seen.filter((value) => value.startsWith("disposed:")).length).toBe(2);
		} finally {
			await context.dispose();
		}
	});
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

	it("passes the registry-owned tool-result strategy into AgentSession compaction", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-session-factory-compaction-"));
		const manager = await SessionManager.create({ filePath: join(root, "session.jsonl"), cwd: root });
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "summary" }] }] });
		const context = createRootContext({ id: "session-factory-compaction", mode: "test", trustedProject: true });
		try {
			for (const definition of [providerRegistry, toolRegistry]) await context.plugin(definition, undefined);
			await context.plugin(workspace, { allowedRoot: root });
			for (const definition of [
				processCapability,
				networkCapability,
				toolApproval,
				toolPolicy,
				toolOutput,
				contextBudget,
				compactionBasic,
				compactionToolResult,
				systemPrompt,
				agentSession,
			]) {
				await context.plugin(definition, undefined);
			}
			const removeFactory = installAgentSessionFactory(context);
			try {
				await manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 0 });
				await manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "old answer" }],
					provider: faux.provider.id,
					model: faux.model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 0,
					stopReason: "stop",
				});
				await manager.appendMessage({
					role: "tool_result",
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text", text: "0123456789" }],
					isError: false,
					timestamp: 1,
				});
				const session = await context.require(agentSessionKey).create({
					allowedRoot: root,
					provider: faux.provider,
					model: { ...faux.model, contextWindow: 100, maxOutputTokens: 10 },
					sessionManager: manager,
					compaction: { keepRecentTokens: 1 },
				});
				await (session as AgentSession).compact();
				expect(context.require(compactionRegistryKey).snapshot()).toHaveLength(1);
				expect(manager.latestSummary?.summary).toBe("summary");
			} finally {
				await removeFactory();
			}
		} finally {
			await context.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
