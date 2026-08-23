import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Model, Provider, StreamOptions, SuccessfulAssistantMessage } from "@di-code/ai";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession } from "./test-agent-session.ts";

function userMessage(text: string, timestamp: number): Extract<Message, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, timestamp: number): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "faux",
		model: "small-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
		stopReason: "stop",
	};
}

function smallModel(model: Model): Model {
	return { ...model, id: "small-model", contextWindow: 24, maxOutputTokens: 6 };
}

function messageText(message: Message): string {
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

interface CapturedRequest {
	readonly context: Context;
	readonly options: StreamOptions | undefined;
}

function captureProvider(provider: Provider, requests: CapturedRequest[]): Provider {
	return {
		...provider,
		stream(model, context, options) {
			requests.push({ context: structuredClone(context), options: structuredClone(options) });
			return provider.stream(model, context, options);
		},
	};
}

describe("AgentSession automatic compaction", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-compaction-"));
		sessionFile = join(root, "session.jsonl");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function seedTwoTurns(manager: SessionManager) {
		const oldUser = await manager.appendMessage(userMessage("old-user", 1));
		const oldAssistant = await manager.appendMessage(assistantMessage("old-asst", 2));
		const recentUser = await manager.appendMessage(userMessage("new-user", 3));
		const recentAssistant = await manager.appendMessage(assistantMessage("new-asst", 4));
		return { oldUser, oldAssistant, recentUser, recentAssistant };
	}

	it("skips compaction below the threshold and calls the provider once", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await session.prompt("short");

		expect(requests).toHaveLength(1);
		expect(manager.latestSummary).toBeUndefined();
		expect(manager.messages.map(messageText)).toEqual(["short", "answer"]);
	});

	it("supports an explicit manual compaction request", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "manual summary" }] }],
		});
		const events: string[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});
		session.subscribeSession((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end")
				events.push(`${event.type}:${event.reason}`);
		});

		await session.compact();

		expect(manager.latestSummary?.summary).toBe("manual summary");
		expect(events).toEqual(["compaction_start:manual", "compaction_end:manual"]);
	});

	it("compacts when context plus the pending user is exactly at the threshold", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "compressed" }] },
				{ type: "success", content: [{ type: "text", text: "final" }] },
			],
		});
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await session.prompt("x".repeat(20));

		expect(requests).toHaveLength(2);
		expect(manager.latestSummary).toMatchObject({ summary: "compressed", tokensBefore: 12 });
		expect(requests[0]?.context.tools).toBeUndefined();
	});

	it("sends only the summary, kept suffix, and pending user to the normal request", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "compressed" }] },
				{ type: "success", content: [{ type: "text", text: "final" }] },
			],
		});
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await session.prompt("x".repeat(20));

		const normalMessages = requests[1]?.context.messages ?? [];
		expect(normalMessages.map((message) => message.role)).toEqual(["user", "user", "assistant", "user"]);
		expect(normalMessages.map(messageText)).toEqual([
			"<conversation-summary>\ncompressed\n</conversation-summary>",
			"new-user",
			"new-asst",
			"x".repeat(20),
		]);
		expect(normalMessages.map(messageText)).not.toContain("old-user");
	});

	it("appends the summary before new prompt messages while preserving complete history", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		const seeded = await seedTwoTurns(manager);
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "compressed" }] },
				{ type: "success", content: [{ type: "text", text: "final" }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await session.prompt("x".repeat(20));

		expect(manager.entries.map((entry) => entry.type)).toEqual([
			"message",
			"message",
			"message",
			"message",
			"summary",
			"message",
			"message",
		]);
		expect(manager.latestSummary?.firstKeptEntryId).toBe(seeded.recentUser.id);
		expect(manager.messages.map(messageText)).toEqual([
			"old-user",
			"old-asst",
			"new-user",
			"new-asst",
			"x".repeat(20),
			"final",
		]);
		expect(session.transcript.map(messageText)).toEqual(manager.messages.map(messageText));
	});

	it("does not persist or continue when summary generation fails", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const before = manager.entries;
		const faux = createFauxProvider({
			responses: [
				{ type: "failure", errorMessage: "summary unavailable" },
				{ type: "success", content: [{ type: "text", text: "must stay unused" }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await expect(session.prompt("x".repeat(20))).rejects.toThrow("Summarization failed: summary unavailable");

		expect(manager.entries).toEqual(before);
		expect(session.transcript).toEqual(manager.messages);
		expect(faux.pendingResponses()).toBe(1);
		expect(session.isStreaming).toBe(false);
	});

	it("does not persist or continue when summary generation is aborted", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const before = manager.entries;
		const controller = new AbortController();
		controller.abort("test cancellation");
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "unused summary" }] },
				{ type: "success", content: [{ type: "text", text: "must stay unused" }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await expect(session.prompt("x".repeat(20), controller.signal)).rejects.toThrow("Summarization aborted");

		expect(manager.entries).toEqual(before);
		expect(faux.pendingResponses()).toBe(1);
		expect(session.isStreaming).toBe(false);
	});

	it("rejects an over-budget prompt when no stored cut point exists", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "must stay unused" }] }],
		});
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await expect(session.prompt("x".repeat(68))).rejects.toThrow(
			"Context limit reached but no valid compaction cut point was found.",
		);

		expect(requests).toEqual([]);
		expect(manager.entries).toEqual([]);
		expect(faux.pendingResponses()).toBe(1);
	});

	it("makes a summary persistence failure sticky for later prompts", async () => {
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			appendOptions: { lockTimeoutMs: 0 },
		});
		await seedTwoTurns(manager);
		await writeFile(`${sessionFile}.lock`, "held", "utf8");
		const before = manager.entries;
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "summary" }] },
				{ type: "success", content: [{ type: "text", text: "must stay unused" }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await expect(session.prompt("x".repeat(20))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
		expect(manager.entries).toEqual(before);
		expect(faux.pendingResponses()).toBe(1);

		await expect(session.prompt("do not retry provider")).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
		expect(faux.pendingResponses()).toBe(1);
	});

	it("keeps an assistant tool call with its tool result on the retained side", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await manager.appendMessage(userMessage("old-user", 1));
		await manager.appendMessage(assistantMessage("old-asst", 2));
		const toolUser = await manager.appendMessage(userMessage("tool-user", 3));
		await manager.appendMessage({
			...assistantMessage("", 4),
			content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
			stopReason: "tool_use",
		});
		await manager.appendMessage({
			role: "tool_result",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: 5,
		});
		await manager.appendMessage(assistantMessage("tool-done", 6));
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "summary" }] },
				{ type: "success", content: [{ type: "text", text: "final" }] },
			],
		});
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 10 },
		});

		await session.prompt("next");

		const normalMessages = requests[1]?.context.messages ?? [];
		expect(manager.latestSummary?.firstKeptEntryId).toBe(toolUser.id);
		expect(normalMessages.map((message) => message.role)).toEqual([
			"user",
			"user",
			"assistant",
			"tool_result",
			"assistant",
			"user",
		]);
		expect(normalMessages[1]).toMatchObject({ role: "user" });
		expect(normalMessages[2]).toMatchObject({ role: "assistant", stopReason: "tool_use" });
		expect(normalMessages[3]).toMatchObject({ role: "tool_result", toolCallId: "call-1" });
	});

	it("uses the latest summary boundary during repeated compaction", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first summary" }] },
				{ type: "success", content: [{ type: "text", text: "first final" }] },
				{ type: "success", content: [{ type: "text", text: "second summary" }] },
				{ type: "success", content: [{ type: "text", text: "second final" }] },
			],
		});
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		await session.prompt("x".repeat(20));
		await session.prompt("y".repeat(20));

		expect(manager.entries.filter((entry) => entry.type === "summary")).toHaveLength(2);
		expect(manager.latestSummary?.summary).toBe("second summary");
		const secondSummaryInput = messageText(requests[2]?.context.messages[0] as Message);
		expect(secondSummaryInput).toContain("<conversation-summary>");
		expect(secondSummaryInput).toContain("first summary");
		const secondNormalMessages = requests[3]?.context.messages ?? [];
		expect(secondNormalMessages.map(messageText).filter((text) => text.includes("conversation-summary"))).toEqual([
			"<conversation-summary>\nsecond summary\n</conversation-summary>",
		]);
		expect(manager.messages.map(messageText)).toEqual([
			"old-user",
			"old-asst",
			"new-user",
			"new-asst",
			"x".repeat(20),
			"first final",
			"y".repeat(20),
			"second final",
		]);
	});

	it("rejects a second prompt while the first is compacting", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "summary in progress" }] },
				{ type: "success", content: [{ type: "text", text: "first final" }] },
				{ type: "success", content: [{ type: "text", text: "must stay unused" }] },
			],
			chunkSize: 1,
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { keepRecentTokens: 5 },
		});

		const first = session.prompt("x".repeat(20));

		expect(session.isStreaming).toBe(true);
		await expect(session.prompt("second")).rejects.toThrow("AgentSession is already processing a prompt.");
		await first;
		expect(faux.pendingResponses()).toBe(1);
		expect(session.isStreaming).toBe(false);
	});

	it("allows compaction to be disabled explicitly", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		await seedTwoTurns(manager);
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "final" }] }] });
		const requests: CapturedRequest[] = [];
		const session = new AgentSession({
			allowedRoot: root,
			provider: captureProvider(faux.provider, requests),
			model: smallModel(faux.model),
			sessionManager: manager,
			compaction: { enabled: false, keepRecentTokens: 5 },
		});

		await session.prompt("x".repeat(20));

		expect(requests).toHaveLength(1);
		expect(requests[0]?.context.messages.map(messageText)).toEqual([
			"old-user",
			"old-asst",
			"new-user",
			"new-asst",
			"x".repeat(20),
		]);
		expect(manager.latestSummary).toBeUndefined();
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid keepRecentTokens value %s",
		async (keepRecentTokens) => {
			const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
			const faux = createFauxProvider({ responses: [] });

			expect(
				() =>
					new AgentSession({
						allowedRoot: root,
						provider: faux.provider,
						model: smallModel(faux.model),
						sessionManager: manager,
						compaction: { keepRecentTokens },
					}),
			).toThrow("compaction.keepRecentTokens must be a positive integer");
		},
	);

	it("rejects a non-boolean compaction enabled value at runtime", async () => {
		const manager = await SessionManager.create({ filePath: sessionFile, cwd: root });
		const faux = createFauxProvider({ responses: [] });

		expect(
			() =>
				new AgentSession({
					allowedRoot: root,
					provider: faux.provider,
					model: smallModel(faux.model),
					sessionManager: manager,
					compaction: { enabled: "yes" as unknown as boolean },
				}),
		).toThrow("compaction.enabled must be a boolean");
	});
});
