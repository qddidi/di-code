import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@di-code/agent";
import { type Context, createFauxProvider, type Message, type Model, type Provider } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession } from "../src/core/session.ts";

function findToolResult(messages: readonly Message[], toolCallId: string) {
	const result = messages.find((message) => message.role === "tool_result" && message.toolCallId === toolCallId);
	if (!result || result.role !== "tool_result") {
		throw new Error(`Missing tool result for ${toolCallId}`);
	}
	return result;
}

describe("AgentSession read integration", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-session-"));
	});

	it("emits session events separately from Agent events", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }] });
		const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
		const events: string[] = [];
		const unsubscribe = session.subscribeSession((event) => {
			events.push(event.type);
		});
		await session.prompt("hello");
		unsubscribe();
		expect(events).toContain("agent_start");
		expect(events).toContain("agent_end");
	});

	it("uses one stable cache session id across provider requests", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first" }] },
				{ type: "success", content: [{ type: "text", text: "second" }] },
			],
		});
		const requestedSessionIds: Array<string | undefined> = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				requestedSessionIds.push(options?.sessionId);
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });

		await session.prompt("first");
		await session.prompt("second");

		expect(session.sessionId).toBeTruthy();
		expect(requestedSessionIds).toEqual([session.sessionId, session.sessionId]);
	});

	it("rejects image attachments before calling a text-only model", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "unused" }] }] });
		const textOnlyModel: Model = { ...faux.model, input: ["text"] };
		let providerCalled = false;
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				providerCalled = true;
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({ allowedRoot: root, provider, model: textOnlyModel });

		await expect(
			session.promptWithImages("describe this", [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]),
		).rejects.toThrow('Model "faux-model" does not support image input.');
		expect(providerCalled).toBe(false);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads a file and sends the tool result to the second provider request", async () => {
		await writeFile(join(root, "notes.txt"), "alpha\nbeta", "utf8");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "read-1",
							name: "read",
							arguments: { path: "notes.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The file contains alpha and beta." }] },
			],
			now: () => 20,
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push([...context.messages]);
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({
			allowedRoot: root,
			provider,
			model: faux.model,
			now: () => 30,
		});
		const events: AgentEvent[] = [];
		const unsubscribe = session.subscribe((event) => {
			events.push(event);
		});

		const assistant = await session.prompt("Read notes.txt");
		unsubscribe();

		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The file contains alpha and beta." }],
		});
		expect(requestedMessages).toHaveLength(2);
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		expect(session.transcript.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"assistant",
		]);
		expect(findToolResult(session.transcript, "read-1")).toMatchObject({
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "alpha\nbeta" }],
		});
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(session.isStreaming).toBe(false);
		expect(faux.pendingResponses()).toBe(0);
	});

	it("returns a read failure to the model and lets the next response recover", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "read-missing",
							name: "read",
							arguments: { path: "missing.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The file could not be read." }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
		});

		const assistant = await session.prompt("Read the missing file");

		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The file could not be read." }],
		});
		const result = findToolResult(session.transcript, "read-missing");
		expect(result.isError).toBe(true);
		const content = result.content[0];
		if (!content || content.type !== "text") {
			throw new Error("Expected a text tool error");
		}
		expect(content.text).toContain('Tool "read" failed:');
		expect(content.text).toContain("ENOENT");
		expect(faux.pendingResponses()).toBe(0);
	});
});

describe("AgentSession persistence", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-agent-session-persistence-"));
		sessionFile = join(root, "session.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("persists a text turn and restores it into the next provider context", async () => {
		const firstFaux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "saved answer" }] }],
		});
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		const firstSession = new AgentSession({
			allowedRoot: root,
			provider: firstFaux.provider,
			model: firstFaux.model,
			sessionManager: manager,
		});
		expect(firstSession.sessionId).toBe(manager.header.id);

		await firstSession.prompt("saved question");

		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		const secondFaux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "continued" }] }],
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...secondFaux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push([...context.messages]);
				return secondFaux.provider.stream(model, context, options);
			},
		};
		const restoredSession = new AgentSession({
			allowedRoot: root,
			provider,
			model: secondFaux.model,
			sessionManager: reopened,
		});

		await restoredSession.prompt("new question");

		expect(requestedMessages[0]?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(restoredSession.sessionFile).toBe(sessionFile);
		expect(restoredSession.sessionDiagnostics).toEqual([]);
	});

	it("persists every completed message in a tool turn exactly once", async () => {
		await writeFile(join(root, "notes.txt"), "stored content", "utf8");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [{ type: "tool_call", id: "read-persisted", name: "read", arguments: { path: "notes.txt" } }],
				},
				{ type: "success", content: [{ type: "text", text: "done" }] },
			],
		});
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
			sessionManager: manager,
		});

		await session.prompt("read notes.txt");

		const reopened = await SessionManager.open(sessionFile);
		expect(reopened.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
		expect(reopened.messages).toHaveLength(session.transcript.length);
	});

	it("surfaces persistence failure and blocks later prompts", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first" }] },
				{ type: "success", content: [{ type: "text", text: "must stay unused" }] },
			],
		});
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			appendOptions: { lockTimeoutMs: 0 },
		});
		await writeFile(`${sessionFile}.lock`, "held", "utf8");
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
			sessionManager: manager,
		});

		await expect(session.prompt("cannot persist")).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
		expect(session.isStreaming).toBe(false);
		expect(faux.pendingResponses()).toBe(1);
		await expect(session.prompt("do not call provider")).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
		expect(faux.pendingResponses()).toBe(1);
	});
});
