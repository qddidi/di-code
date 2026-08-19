import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, type Message, type Provider } from "@di-code/ai";
import type { Component, Terminal } from "@di-code/tui";
import { CURSOR_MARKER, TUI, visibleWidth } from "@di-code/tui";
import { describe, it } from "vitest";
import { clipboardImageDirectory } from "../src/core/clipboard-image.ts";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession } from "../src/core/session.ts";
import { ExtensionHost } from "../src/extensions/runtime.ts";
import { InteractiveMode, InteractiveProjection } from "../src/modes/interactive.ts";
import { InteractiveChat, type InteractiveViewState } from "../src/modes/interactive-components.ts";
import { resolveStartupRuntime } from "../src/startup.ts";

const PASTE_IMAGE_INPUT = process.platform === "win32" ? "\x1bv" : "\x16";

class TestTerminal implements Terminal {
	private input?: (data: string) => void;
	private readonly writes: string[] = [];
	private readonly failStart: boolean;
	readonly columns: number;
	readonly rows: number;
	started = false;
	cursorHidden = false;
	constructor(failStart = false, columns = 80, rows = 24) {
		this.failStart = failStart;
		this.columns = columns;
		this.rows = rows;
	}
	start(onInput: (data: string) => void): void {
		this.started = true;
		this.input = onInput;
		if (this.failStart) throw new Error("terminal start failed");
	}
	stop(): void {
		this.started = false;
		this.input = undefined;
	}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(lines: number): void {
		if (lines !== 0) this.write(`move:${lines}`);
	}
	hideCursor(): void {
		this.cursorHidden = true;
	}
	showCursor(): void {
		this.cursorHidden = false;
	}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(): void {}
	sendInput(data: string): void {
		this.input?.(data);
	}
	clearOutput(): void {
		this.writes.length = 0;
	}
	get output(): string {
		return this.writes.join("");
	}
}

function preview(text: string) {
	return { role: "assistant" as const, provider: "faux", model: "faux-model", text };
}

function assistantMessage(text: string, stopReason: "stop" | "error" = "stop") {
	if (stopReason === "error") {
		return {
			role: "assistant" as const,
			content: [],
			provider: "faux",
			model: "faux-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
			stopReason,
			errorMessage: "model failed",
		};
	}
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		provider: "faux",
		model: "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
		stopReason,
	};
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (predicate()) return;
		await flush();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(predicate(), true);
}

describe("InteractiveProjection", () => {
	it("previews edit changes from the real file with context and line numbers", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-edit-preview-"));
		try {
			writeFileSync(join(root, "notes.txt"), "first\nconst old = 1;\nlast", "utf8");
			let changed = false;
			const projection = new InteractiveProjection();
			projection.configureFilePreview(root, () => {
				changed = true;
			});
			projection.apply({
				type: "tool_execution_start",
				toolCallId: "edit-preview",
				toolName: "edit",
				arguments: { path: "notes.txt", oldText: "const old = 1;", newText: "const next = 2;" },
			});
			await waitFor(() => changed);
			const change = projection.state.messageItems[0];
			assert.equal(change?.role, "file_change");
			if (change?.role !== "file_change") throw new Error("Expected file change preview");
			assert.equal(change.diff?.includes(" 1 first"), true);
			assert.equal(change.diff?.includes("-2 const old = 1;"), true);
			assert.equal(change.diff?.includes("+2 const next = 2;"), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps successful edit changes as colored diff items after the agent turn ends", () => {
		const projection = new InteractiveProjection();
		projection.apply({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			arguments: { path: "src/app.ts", oldText: "const old = 1;", newText: "const next = 2;" },
		});
		projection.apply({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			result: {
				role: "tool_result",
				toolCallId: "edit-1",
				toolName: "edit",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 1,
			},
		});
		projection.apply({ type: "agent_end", messages: [] });

		assert.deepEqual(projection.state.messageItems, [
			{
				role: "file_change",
				id: "edit-1",
				path: "src/app.ts",
				kind: "edit",
				removed: ["const old = 1;"],
				added: ["const next = 2;"],
			},
		]);
	});

	it("does not keep failed file changes in the completed transcript", () => {
		const projection = new InteractiveProjection();
		projection.apply({
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			arguments: { path: "src/app.ts", content: "const answer = 42;" },
		});
		projection.apply({
			type: "tool_execution_end",
			toolCallId: "write-1",
			toolName: "write",
			result: {
				role: "tool_result",
				toolCallId: "write-1",
				toolName: "write",
				content: [{ type: "text", text: "permission denied" }],
				isError: true,
				timestamp: 1,
			},
		});

		assert.deepEqual(projection.state.messageItems, []);
	});

	it("restores successful edit changes from the persisted transcript", () => {
		const projection = new InteractiveProjection();
		projection.replaceTranscript([
			{
				role: "assistant",
				content: [
					{
						type: "tool_call",
						id: "edit-1",
						name: "edit",
						arguments: { path: "src/app.ts", oldText: "const old = 1;", newText: "const next = 2;" },
					},
				],
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1,
				stopReason: "tool_use",
			},
			{
				role: "tool_result",
				toolCallId: "edit-1",
				toolName: "edit",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		]);

		assert.deepEqual(projection.state.messageItems, [
			{
				role: "file_change",
				id: "edit-1",
				path: "src/app.ts",
				kind: "edit",
				removed: ["const old = 1;"],
				added: ["const next = 2;"],
			},
		]);
	});

	it("projects transient thinking and tool process items in event order", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "agent_start" });
		assert.deepEqual(projection.state.processItems, [{ type: "thinking", id: "thinking" }]);

		projection.apply({
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			arguments: { path: "a.txt" },
		});
		assert.deepEqual(projection.state.processItems, [
			{ type: "tool", id: "r1", command: 'read {"path":"a.txt"}', status: "running" },
		]);

		projection.apply({
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			result: {
				role: "tool_result",
				toolCallId: "r1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		});
		projection.apply({ type: "turn_start" });
		assert.deepEqual(projection.state.processItems, [
			{ type: "tool", id: "r1", command: 'read {"path":"a.txt"}', status: "done" },
			{ type: "thinking", id: "thinking" },
		]);

		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: "answer" },
		});
		assert.deepEqual(projection.state.processItems, [
			{ type: "tool", id: "r1", command: 'read {"path":"a.txt"}', status: "done" },
		]);
		projection.apply({ type: "agent_end", messages: [] });
		assert.deepEqual(projection.state.processItems, []);
	});

	it("clears transient process items when the mode stops during a prompt", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "agent_start" });
		projection.apply({
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			arguments: { path: "a.txt" },
		});
		projection.clearTransientProcess();
		assert.deepEqual(projection.state.processItems, []);
		assert.deepEqual(projection.state.toolStatus, []);
	});

	it("renders a tool command on one truncated line and removes it after the run", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "agent_start" });
		const readState = (): InteractiveViewState => ({ ...projection.state, model: "faux-model", theme: "dark" });
		assert.equal(new InteractiveChat(readState).render(32).join("\n").includes("Thinking"), true);
		projection.apply({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			arguments: { command: "echo this command is deliberately longer than the terminal" },
		});
		const output = new InteractiveChat(readState).render(32).join("\n");
		assert.equal(output.includes("bash"), true);
		assert.equal(output.includes("..."), true);
		assert.equal(output.includes("ACTIVITY"), false);
		projection.apply({ type: "agent_end", messages: [] });
		assert.equal(new InteractiveChat(readState).render(32).join("\n").includes("bash"), false);
	});

	it("projects user and assistant streaming messages", () => {
		const projection = new InteractiveProjection();
		const user = { role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 1 };
		projection.apply({ type: "agent_start" });
		projection.apply({ type: "message_start", message: user });
		projection.apply({ type: "message_end", message: user });
		projection.apply({ type: "message_start", message: preview("") });
		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: "hel" },
		});
		projection.apply({
			type: "message_update",
			event: { type: "thinking_delta", contentIndex: 1, delta: "hidden" },
		});
		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: "lo" },
		});

		assert.deepEqual(projection.state.messages, ["hello"]);
		assert.equal(projection.state.streamingText, "hello");
		assert.equal(projection.state.busy, true);
	});

	it("removes the loading spinner when the first response character arrives", () => {
		const projection = new InteractiveProjection();
		const readState = (): InteractiveViewState => ({ ...projection.state, model: "faux-model", theme: "dark" });
		const chat = new InteractiveChat(readState);

		projection.apply({ type: "agent_start" });
		projection.apply({ type: "message_update", event: { type: "text_delta", contentIndex: 0, delta: "" } });
		assert.equal(chat.render(80).join("\n").includes("Thinking"), true);
		projection.apply({ type: "message_update", event: { type: "text_delta", contentIndex: 0, delta: "partial" } });

		assert.equal(projection.state.busy, true);
		assert.equal(chat.render(80).join("\n").includes("Thinking"), false);
		const firstFrame = projection.state.spinnerFrame;
		assert.equal(projection.advanceSpinner(), true);
		assert.notEqual(projection.state.spinnerFrame, firstFrame);
	});

	it("adds one blank line before and after thinking process feedback", () => {
		const baseState = new InteractiveProjection().state;
		const lines = new InteractiveChat(() => ({
			...baseState,
			messageItems: [{ role: "user" as const, text: "question" }],
			processItems: [{ type: "thinking" as const, id: "thinking" }],
			busy: true,
			model: "faux-model",
			theme: "dark" as const,
		})).render(40);
		const thinkingIndex = lines.findIndex((line) => line.includes("Thinking"));

		assert.ok(thinkingIndex > 0);
		assert.equal(lines[thinkingIndex - 1]?.trim(), "");
		assert.equal(lines[thinkingIndex + 1]?.trim(), "");
	});

	it("projects tool execution start and end", () => {
		const projection = new InteractiveProjection();
		projection.apply({
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			arguments: { path: "a.txt" },
		});
		assert.deepEqual(projection.state.toolStatus, ["read: running"]);
		projection.apply({
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			result: {
				role: "tool_result",
				toolCallId: "r1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		});
		assert.deepEqual(projection.state.toolStatus, ["read: done"]);
	});

	it("clears tool activity when the next agent turn starts", () => {
		const projection = new InteractiveProjection();
		projection.apply({
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			arguments: { path: "a.txt" },
		});
		projection.apply({
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			result: {
				role: "tool_result",
				toolCallId: "r1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		});

		projection.apply({ type: "agent_start" });

		assert.deepEqual(projection.state.toolStatus, []);
	});

	it("commits final assistant text and clears streaming state", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "agent_start" });
		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: "done" },
		});
		projection.apply({ type: "message_end", message: assistantMessage("done") });
		projection.apply({ type: "agent_end", messages: [] });

		assert.deepEqual(projection.state.messages, ["done"]);
		assert.deepEqual(projection.state.messageItems, [{ role: "assistant", text: "done" }]);
		assert.equal(projection.state.streamingText, "");
		assert.equal(projection.state.busy, false);
	});

	it("keeps user and assistant roles in the display projection", () => {
		const projection = new InteractiveProjection();
		const user = { role: "user" as const, content: [{ type: "text" as const, text: "question" }], timestamp: 1 };
		projection.apply({ type: "message_end", message: user });
		projection.apply({ type: "message_end", message: assistantMessage("answer") });

		assert.deepEqual(projection.state.messageItems, [
			{ role: "user", text: "question" },
			{ role: "assistant", text: "answer" },
		]);
	});

	it("stores assistant errors without throwing", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "message_end", message: assistantMessage("", "error") });
		assert.equal(projection.state.error, "model failed");
	});

	it("projects compaction lifecycle", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "compaction_start", reason: "threshold" });
		assert.equal(projection.state.compacting, true);
		projection.apply({ type: "compaction_end", reason: "threshold", success: false, errorMessage: "compact failed" });
		assert.equal(projection.state.compacting, false);
		assert.equal(projection.state.error, "compact failed");
	});
});

describe("InteractiveChat streaming layout", () => {
	it("renders line-numbered context and intra-line edit changes", () => {
		const usage = new InteractiveProjection().state.usage;
		const lines = new InteractiveChat(() => ({
			messages: [],
			messageItems: [
				{
					role: "file_change",
					id: "edit-diff",
					path: "src/app.ts",
					kind: "edit",
					removed: [],
					added: [],
					diff: " 1 const value = 1;\n-2 const old = 1;\n+2 const next = 2;\n 3 return value;",
				},
			],
			streamingText: "",
			toolStatus: [],
			processItems: [],
			busy: false,
			queue: [],
			status: "",
			error: "",
			retrying: false,
			compacting: false,
			spinnerFrame: 0,
			usage,
			model: "faux-model",
			theme: "dark",
		})).render(80);
		const output = lines.join("\n");
		assert.equal(output.includes(" 1 const value = 1;"), true);
		assert.equal(output.includes("-2 const "), true);
		assert.equal(output.includes("+2 const "), true);
		assert.equal(output.includes("\x1b[7m"), true);
	});

	it("renders persisted file changes as colored diffs without overflowing", () => {
		const baseState = new InteractiveProjection().state;
		const lines = new InteractiveChat(() => ({
			...baseState,
			messageItems: [
				{
					role: "file_change" as const,
					id: "edit-1",
					path: "src/app.ts",
					kind: "edit" as const,
					removed: ["const old = 1;"],
					added: ["const next = 2;"],
				},
			],
			model: "faux-model",
			theme: "dark" as const,
		})).render(40);
		const output = lines.join("\n");

		assert.equal(output.includes("Edited src/app.ts"), true);
		assert.equal(output.includes("- const old = 1;"), true);
		assert.equal(output.includes("+ const next = 2;"), true);
		assert.equal(output.includes("\x1b[38;5;210m- const old = 1;"), true);
		assert.equal(output.includes("\x1b[38;5;114m+ const next = 2;"), true);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	});

	it("uses compact semantic message hierarchy without overflowing 40 columns", () => {
		const usage = new InteractiveProjection().state.usage;
		const readState = (): InteractiveViewState => ({
			messages: ["a focused user question", "assistant response"],
			messageItems: [
				{ role: "user", text: "a focused user question" },
				{ role: "assistant", text: "# Answer\n\nA **clear** response." },
			],
			streamingText: "",
			toolStatus: [],
			processItems: [],
			busy: false,
			queue: [],
			status: "",
			error: "",
			retrying: false,
			compacting: false,
			spinnerFrame: 0,
			usage,
			model: "faux-model",
			theme: "dark",
		});

		const lines = new InteractiveChat(readState).render(40);
		const output = lines.join("\n");

		assert.equal(output.includes("You"), false);
		assert.equal(output.includes("Assistant"), false);
		assert.equal(output.includes("\x1b[48;2;31;39;50m"), true);
		assert.equal(output.includes("┌"), false);
		assert.equal(output.includes("\x1b[48;2;31;39;50m  a focused user question"), true);
		assert.equal(lines.filter((line) => line === `\x1b[48;2;31;39;50m${" ".repeat(40)}\x1b[0m`).length, 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	});

	it("syntax-highlights fenced TypeScript but falls back for unknown languages", () => {
		const usage = new InteractiveProjection().state.usage;
		const readState = (text: string): InteractiveViewState => ({
			messages: [text],
			messageItems: [{ role: "assistant", text }],
			streamingText: "",
			toolStatus: [],
			processItems: [],
			busy: false,
			queue: [],
			status: "",
			error: "",
			retrying: false,
			compacting: false,
			spinnerFrame: 0,
			usage,
			model: "faux-model",
			theme: "dark",
		});

		const typescript = new InteractiveChat(() => readState("```ts\nconst answer = 42;\n``` ")).render(80).join("\n");
		const unknown = new InteractiveChat(() => readState("```not-a-language\nconst answer = 42;\n``` "))
			.render(80)
			.join("\n");

		assert.equal(typescript.includes("\x1b[36mconst"), true);
		assert.equal(unknown.includes("\x1b[36mconst"), false);
	});

	it("commits a long streamed answer without replaying the frame", async () => {
		const projection = new InteractiveProjection();
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "inspect the current project" }],
			timestamp: 1,
		};
		const longAnswer = Array.from({ length: 40 }, (_, index) => `answer line ${index}`).join("\n");
		projection.apply({ type: "agent_start" });
		projection.apply({ type: "message_end", message: userMessage });
		projection.apply({ type: "message_start", message: preview("") });
		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: longAnswer },
		});
		const readState = (): InteractiveViewState => ({
			...projection.state,
			model: "faux-model",
			theme: "dark",
		});
		const terminal = new TestTerminal(false, 80, 24);
		const tui = new TUI(terminal);
		const tail: Component = {
			invalidate() {},
			render: () => Array.from({ length: 8 }, (_, index) => `tail ${index}`),
		};
		tui.addChild(new InteractiveChat(readState));
		tui.addChild(tail);
		tui.start();
		terminal.clearOutput();

		projection.apply({ type: "message_end", message: assistantMessage(longAnswer) });
		projection.apply({ type: "agent_end", messages: [] });
		tui.requestRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		assert.equal(terminal.output.includes("\x1b[3J"), false);
		tui.stop();
	});

	it("keeps the final answer in the writable viewport after many tool calls", async () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "agent_start" });
		for (let index = 0; index < 30; index += 1) {
			projection.apply({
				type: "tool_execution_start",
				toolCallId: `tool-${index}`,
				toolName: `tool-${index}`,
				arguments: {},
			});
			projection.apply({
				type: "tool_execution_end",
				toolCallId: `tool-${index}`,
				toolName: `tool-${index}`,
				result: {
					role: "tool_result",
					toolCallId: `tool-${index}`,
					toolName: `tool-${index}`,
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: index,
				},
			});
		}
		projection.apply({ type: "message_start", message: preview("") });
		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: "final answer" },
		});
		const readState = (): InteractiveViewState => ({
			...projection.state,
			model: "faux-model",
			theme: "dark",
		});
		const terminal = new TestTerminal(false, 80, 24);
		const tui = new TUI(terminal);
		const tail: Component = {
			invalidate() {},
			render: () => Array.from({ length: 8 }, (_, index) => `tail ${index}`),
		};
		tui.addChild(new InteractiveChat(readState));
		tui.addChild(tail);
		tui.start();
		terminal.clearOutput();

		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: " continues" },
		});
		tui.requestRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		const frame = tui.render(terminal.columns).join("\n");
		assert.equal(frame.includes("24 earlier tool updates"), true);
		assert.equal(frame.includes("tool-0"), false);
		assert.equal(frame.includes("tool-29"), true);
		assert.equal(terminal.output.includes("\x1b[3J"), false);
		assert.equal(terminal.output.includes("final answer continues"), true);

		terminal.clearOutput();
		projection.apply({ type: "message_end", message: assistantMessage("final answer continues") });
		projection.apply({ type: "agent_end", messages: [] });
		tui.requestRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		assert.equal(terminal.output.includes("\x1b[3J"), false);
		tui.stop();
	});
});

describe("InteractiveMode", () => {
	it("runs extension slash commands and emits session lifecycle exactly once", async () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const host = new ExtensionHost({ cwd: process.cwd(), mode: "interactive", projectTrusted: true });
		const events: string[] = [];
		await host.registerExtension("test", (api) => {
			api.registerCommand({
				name: "hello",
				description: "hello",
				handler: async (ctx) => {
					events.push(`command:${ctx.args}`);
				},
			});
			api.on("session_start", () => {
				events.push("start");
			});
			api.on("session_shutdown", () => {
				events.push("shutdown");
			});
		});
		const terminal = new TestTerminal();
		const mode = new InteractiveMode({ session, tui: new TUI(terminal), extensionHost: host });
		mode.start();
		terminal.sendInput("/hello world");
		terminal.sendInput("\r");
		await flush();
		mode.stop();
		mode.stop();
		assert.deepEqual(events, ["start", "command:world", "shutdown"]);
	});
	it("rolls back terminal state when startup fails", () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal(true);
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		assert.throws(() => mode.start(), /terminal start failed/);
		assert.equal(terminal.started, false);
		assert.equal(terminal.cursorHidden, false);
		assert.doesNotThrow(() => mode.stop());
	});

	it("renders a structured 80x24 interactive workspace before the first prompt", () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		mode.start();

		assert.equal(terminal.output.includes("DI-CODE / INTERACTIVE"), true);
		assert.equal(terminal.output.includes("MODEL  faux-model"), true);
		assert.equal(terminal.output.includes("READY"), true);
		assert.equal(terminal.output.includes("Enter send"), true);
		mode.stop();
	});

	it("condenses the workspace status without overflowing a narrow terminal", () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal(false, 36, 24);
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		assert.doesNotThrow(() => mode.start());
		assert.equal(terminal.output.includes("DI-CODE"), true);
		assert.equal(terminal.output.includes("READY"), true);
		assert.equal(terminal.output.includes("Enter send"), true);
		mode.stop();
	});

	it("expands with complete chat history while keeping overlays in the current viewport", async () => {
		const responses = Array.from({ length: 8 }, (_, index) => ({
			type: "success" as const,
			content: [{ type: "text" as const, text: `answer ${index}` }],
		}));
		const faux = createFauxProvider({ responses });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		for (let index = 0; index < responses.length; index += 1) await session.prompt(`question ${index}`);
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		mode.start();
		const baseFrame = tui.render(terminal.columns);
		assert.equal(baseFrame.length > terminal.rows, true);
		assert.equal(baseFrame.at(-2)?.includes("READY"), true);
		assert.equal(
			baseFrame.some((line) => line.includes("answer 7")),
			true,
		);
		assert.equal(
			baseFrame.some((line) => line.includes("answer 0")),
			true,
		);
		assert.equal(terminal.output.includes("answer 0"), true);
		assert.equal(terminal.output.includes("answer 7"), true);

		terminal.sendInput("\x0f");
		await flush();
		const overlayFrame = tui.render(terminal.columns);
		assert.equal(overlayFrame.length, baseFrame.length);
		assert.equal(overlayFrame.at(-2)?.includes("READY"), true);
		assert.equal(
			overlayFrame.slice(-terminal.rows).some((line) => line.includes("Faux Model")),
			true,
		);
		mode.stop();
	});

	it("returns control to the shell without replaying the complete transcript", async () => {
		const responses = Array.from({ length: 8 }, (_, index) => ({
			type: "success" as const,
			content: [{ type: "text" as const, text: `answer ${index}` }],
		}));
		const faux = createFauxProvider({ responses });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		for (let index = 0; index < responses.length; index += 1) await session.prompt(`question ${index}`);
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		let exited = false;
		const mode = new InteractiveMode({
			session,
			tui,
			onExit: () => {
				exited = true;
			},
		});
		mode.start();
		terminal.clearOutput();

		terminal.sendInput("\x03");

		assert.equal(exited, true);
		assert.equal(terminal.output.includes("question 0"), false);
		assert.equal(terminal.output.includes("\r\n"), true);
		assert.equal(terminal.started, false);
		assert.equal(terminal.cursorHidden, false);
	});

	it("submits editor input through AgentSession and renders the answer", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "hello from model" }] }],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		mode.start();
		terminal.clearOutput();
		terminal.sendInput("hello");
		terminal.sendInput("\r");
		await waitFor(() => session.transcript.length === 2);
		await waitFor(() => terminal.output.includes("hello from model"));

		assert.equal(session.transcript.at(-1)?.role, "assistant");
		assert.equal(terminal.output.includes("hello from model"), true);
		assert.equal(terminal.output.includes(CURSOR_MARKER), false);
		mode.stop();
	});

	it("attaches a dropped image path to the next interactive prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-image-"));
		try {
			const imagePath = join(root, "diagram.png");
			writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "image answer" }] }],
			});
			let content: import("@di-code/ai").UserContent[] | undefined;
			const provider: Provider = {
				...faux.provider,
				stream(model, context, options) {
					const user = context.messages.find((message) => message.role === "user");
					content = user?.role === "user" ? [...user.content] : undefined;
					return faux.provider.stream(model, context, options);
				},
			};
			const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
			const terminal = new TestTerminal();
			const mode = new InteractiveMode({ session, tui: new TUI(terminal) });

			mode.start();
			terminal.sendInput(`\x1b[200~${imagePath}\x1b[201~`);
			terminal.sendInput("describe this image");
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);

			assert.deepEqual(content, [
				{ type: "text", text: "[Attached image: diagram.png]\ndescribe this image" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			]);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recognizes a dropped image path when the terminal sends it as plain text", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-plain-image-"));
		try {
			const imagePath = join(root, "plain-drop.jpg");
			writeFileSync(imagePath, Buffer.from([255, 216, 255]));
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "image answer" }] }],
			});
			let content: import("@di-code/ai").UserContent[] | undefined;
			const provider: Provider = {
				...faux.provider,
				stream(model, context, options) {
					const user = context.messages.find((message) => message.role === "user");
					content = user?.role === "user" ? [...user.content] : undefined;
					return faux.provider.stream(model, context, options);
				},
			};
			const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
			const terminal = new TestTerminal();
			const mode = new InteractiveMode({ session, tui: new TUI(terminal) });

			mode.start();
			terminal.sendInput(`${imagePath}这是什么图片`);
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);

			assert.deepEqual(content, [
				{ type: "text", text: "[Attached image: plain-drop.jpg]\n这是什么图片" },
				{ type: "image", data: "/9j/", mimeType: "image/jpeg" },
			]);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("inserts a clipboard image path at the cursor and attaches it on the platform paste shortcut", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-clipboard-"));
		try {
			const agentDir = join(root, "agent");
			const clipboardDirectory = clipboardImageDirectory(agentDir, root);
			mkdirSync(clipboardDirectory, { recursive: true });
			const imagePath = join(clipboardDirectory, "di-code-clipboard-00000000-0000-0000-0000-000000000000.png");
			writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "image answer" }] }],
			});
			let content: import("@di-code/ai").UserContent[] | undefined;
			const provider: Provider = {
				...faux.provider,
				stream(model, context, options) {
					const user = context.messages.find((message) => message.role === "user");
					content = user?.role === "user" ? [...user.content] : undefined;
					return faux.provider.stream(model, context, options);
				},
			};
			const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
			const terminal = new TestTerminal();
			let clipboardReads = 0;
			const mode = new InteractiveMode({
				session,
				tui: new TUI(terminal),
				agentDir,
				readClipboardImagePath: async () => {
					clipboardReads += 1;
					return imagePath;
				},
			});

			mode.start();
			terminal.sendInput(PASTE_IMAGE_INPUT);
			await waitFor(() => clipboardReads === 1);
			await flush();
			terminal.sendInput(" describe this image");
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);

			assert.deepEqual(content, [
				{
					type: "text",
					text: "[Attached image: di-code-clipboard-00000000-0000-0000-0000-000000000000.png]\ndescribe this image",
				},
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			]);
			await waitFor(() => !existsSync(imagePath));
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("attaches multiple clipboard paths inserted by repeated paste shortcuts", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-clipboard-many-"));
		try {
			const firstPath = join(root, "first.png");
			const secondPath = join(root, "second.jpg");
			writeFileSync(firstPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			writeFileSync(secondPath, Buffer.from([255, 216, 255]));
			const paths = [firstPath, secondPath];
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "image answer" }] }],
			});
			let content: import("@di-code/ai").UserContent[] | undefined;
			const provider: Provider = {
				...faux.provider,
				stream(model, context, options) {
					const user = context.messages.find((message) => message.role === "user");
					content = user?.role === "user" ? [...user.content] : undefined;
					return faux.provider.stream(model, context, options);
				},
			};
			const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
			const terminal = new TestTerminal();
			let clipboardReads = 0;
			const mode = new InteractiveMode({
				session,
				tui: new TUI(terminal),
				readClipboardImagePath: async () => {
					clipboardReads += 1;
					return paths.shift() ?? null;
				},
			});

			mode.start();
			terminal.sendInput(PASTE_IMAGE_INPUT);
			await waitFor(() => clipboardReads === 1);
			await flush();
			terminal.sendInput(PASTE_IMAGE_INPUT);
			await waitFor(() => clipboardReads === 2);
			await flush();
			terminal.sendInput(" compare them");
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);

			assert.deepEqual(content, [
				{ type: "text", text: "[Attached image: first.png]\n[Attached image: second.jpg]\ncompare them" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				{ type: "image", data: "/9j/", mimeType: "image/jpeg" },
			]);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes an inserted clipboard path with Ctrl+U before sending", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-clipboard-delete-"));
		try {
			const agentDir = join(root, "agent");
			const clipboardDirectory = clipboardImageDirectory(agentDir, root);
			mkdirSync(clipboardDirectory, { recursive: true });
			const imagePath = join(clipboardDirectory, "di-code-clipboard-00000000-0000-0000-0000-000000000001.png");
			writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "text answer" }] }],
			});
			let content: import("@di-code/ai").UserContent[] | undefined;
			const provider: Provider = {
				...faux.provider,
				stream(model, context, options) {
					const user = context.messages.find((message) => message.role === "user");
					content = user?.role === "user" ? [...user.content] : undefined;
					return faux.provider.stream(model, context, options);
				},
			};
			const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
			const terminal = new TestTerminal();
			let clipboardRead = false;
			const mode = new InteractiveMode({
				session,
				tui: new TUI(terminal),
				agentDir,
				readClipboardImagePath: async () => {
					clipboardRead = true;
					return imagePath;
				},
			});

			mode.start();
			terminal.sendInput(PASTE_IMAGE_INPUT);
			await waitFor(() => clipboardRead);
			await flush();
			terminal.sendInput("\x15");
			await waitFor(() => !existsSync(imagePath));
			terminal.sendInput("text only");
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);

			assert.deepEqual(content, [{ type: "text", text: "text only" }]);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders assistant responses with the Markdown component", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "**bold answer**" }] }],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		mode.start("question");
		await waitFor(() => session.transcript.length === 2);
		await waitFor(() => terminal.output.includes("bold answer"));

		assert.equal(terminal.output.includes("Assistant"), false);
		assert.equal(terminal.output.includes("bold answer"), true);
		assert.equal(terminal.output.includes("\x1b[1m"), true);
		mode.stop();
	});

	it("separates user, assistant, and activity content into readable transcript regions", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "A focused answer" }] }],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });

		mode.start("A focused question");
		await waitFor(() => session.transcript.length === 2);
		await waitFor(() => terminal.output.includes("A focused answer"));

		assert.equal(terminal.output.includes("You"), false);
		assert.equal(terminal.output.includes("Assistant"), false);
		assert.equal(terminal.output.includes("\x1b[48;2;31;39;50m"), true);
		assert.equal(terminal.output.includes("A focused question"), true);
		assert.equal(terminal.output.includes("A focused answer"), true);
		mode.stop();
	});

	it("cancels an active prompt with Escape and stops safely with Ctrl+C", async () => {
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [{ type: "success", content: [{ type: "text", text: "a".repeat(1000) }] }],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		let exited = false;
		const mode = new InteractiveMode({
			session,
			tui,
			onExit: () => {
				exited = true;
			},
		});

		mode.start();
		terminal.sendInput("hello");
		terminal.sendInput("\r");
		await flush();
		terminal.sendInput("\x1b");
		await waitFor(() => session.transcript.at(-1)?.role === "assistant");
		assert.equal(session.transcript.at(-1)?.role, "assistant");
		terminal.sendInput("\x03");
		assert.equal(exited, true);
		mode.stop();
	});

	it("switches sessions through an overlay and restores the selected transcript", async () => {
		const firstFaux = createFauxProvider({ responses: [] });
		const secondFaux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "restored answer" }] },
				{ type: "success", content: [{ type: "text", text: "new answer" }] },
			],
		});
		const firstSession = new AgentSession({
			allowedRoot: process.cwd(),
			provider: firstFaux.provider,
			model: firstFaux.model,
		});
		const secondSession = new AgentSession({
			allowedRoot: process.cwd(),
			provider: secondFaux.provider,
			model: secondFaux.model,
		});
		await secondSession.prompt("old question");
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({
			session: firstSession,
			tui,
			sessions: [{ id: "new-session", label: "New session", open: () => secondSession }],
		});
		mode.start();
		terminal.sendInput("\x0c");
		assert.equal(tui.hasOverlay(), true);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await waitFor(() => terminal.output.includes("restored answer"));
		terminal.sendInput("next question");
		terminal.sendInput("\r");
		await waitFor(() => secondSession.transcript.length === 4);

		assert.equal(tui.hasOverlay(), false);
		assert.equal(firstSession.transcript.length, 0);
		assert.equal(terminal.output.includes("session=new-session"), true);
		mode.stop();
	});

	it("uses a SelectList overlay to change the theme", async () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("\x14");
		assert.equal(tui.hasOverlay(), true);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await waitFor(() => terminal.output.includes("theme=light"));

		assert.equal(tui.hasOverlay(), false);
		assert.equal(terminal.output.includes("theme=light"), true);
		mode.stop();
	});

	it("switches to a provider model and uses it for the next prompt", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "alternate answer" }] }],
		});
		const alternate = { ...faux.model, id: "alternate-model", name: "Alternate model" };
		const streamedModels: string[] = [];
		const provider: Provider = {
			...faux.provider,
			models: [faux.model, alternate],
			stream(model, context, options) {
				streamedModels.push(model.id);
				return faux.provider.stream(faux.model, context, options);
			},
		};
		const session = new AgentSession({ allowedRoot: process.cwd(), provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("\x0f");
		assert.equal(tui.hasOverlay(), true);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		terminal.sendInput("question");
		terminal.sendInput("\r");
		await waitFor(() => streamedModels.length === 1);
		await waitFor(() => terminal.output.includes("MODEL  alternate-model"));

		assert.equal(session.modelId, "alternate-model");
		assert.deepEqual(streamedModels, ["alternate-model"]);
		assert.equal(terminal.output.includes("MODEL  alternate-model"), true);
		mode.stop();
	});

	it("uses /login to save a global key and switch the current session runtime without rendering the key", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-login-"));
		try {
			const faux = createFauxProvider({ responses: [] });
			const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
			const terminal = new TestTerminal();
			const tui = new TUI(terminal);
			const mode = new InteractiveMode({
				session,
				tui,
				providerOnboarding: { configuration: { environment: {}, providers: [] }, agentDir: join(root, "agent") },
			});
			mode.start();

			terminal.sendInput("/login");
			terminal.sendInput("\r");
			await waitFor(() => tui.hasOverlay());
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			terminal.sendInput("\r");
			terminal.sendInput("interactive-login-secret");
			terminal.sendInput("\r");
			await waitFor(() => session.providerId === "deepseek");

			assert.equal(session.modelId, "deepseek-v4-flash");
			assert.equal(tui.render(terminal.columns).join("\n").includes(CURSOR_MARKER), true);
			assert.equal(terminal.output.includes("interactive-login-secret"), false);
			assert.deepEqual(JSON.parse(readFileSync(join(root, "agent", "settings.json"), "utf8")), {
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-flash",
				providers: { deepseek: { api: "openai-chat-completions", apiKey: "interactive-login-secret" } },
			});
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses /logout to remove only the current global key and rebuild the session runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-logout-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					providers: {
						deepseek: {
							api: "openai-chat-completions",
							apiKey: "stored-logout-secret",
							baseUrl: "https://api.deepseek.example.test/v1",
							models: [{ id: "deepseek-v4-flash" }],
						},
						other: { api: "openai-responses", apiKey: "other-secret", models: [{ id: "other-model" }] },
					},
				}),
			);
			const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "environment-secret" }, [
				{
					id: "deepseek",
					api: "openai-chat-completions",
					apiKey: "stored-logout-secret",
					models: [
						{
							id: "deepseek-v4-flash",
							name: "DeepSeek-V4 Flash",
							provider: "deepseek",
							api: "openai-chat-completions",
							input: ["text"],
							reasoning: false,
							contextWindow: 128000,
							maxOutputTokens: 16384,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			]);
			const session = new AgentSession({ allowedRoot: root, provider: runtime.provider, model: runtime.model });
			const terminal = new TestTerminal();
			const mode = new InteractiveMode({
				session,
				tui: new TUI(terminal),
				providerOnboarding: {
					configuration: { environment: { DEEPSEEK_API_KEY: "environment-secret" }, providers: [] },
					agentDir,
				},
			});
			mode.start();

			terminal.sendInput("/logout");
			terminal.sendInput("\r");
			await waitFor(() => terminal.output.includes("global API key removed"));

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			assert.deepEqual(settings.providers.deepseek, {
				api: "openai-chat-completions",
				baseUrl: "https://api.deepseek.example.test/v1",
				models: [{ id: "deepseek-v4-flash" }],
			});
			assert.equal(settings.providers.other.apiKey, "other-secret");
			assert.equal(terminal.output.includes("stored-logout-secret"), false);
			assert.equal(terminal.output.includes("environment-secret"), false);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cycles thinking level with Shift+Tab and shows it beside the model", async () => {
		const faux = createFauxProvider({ responses: [] });
		const model = { ...faux.model, reasoning: true, reasoningEfforts: ["low", "medium", "high"] as const };
		const provider: Provider = { ...faux.provider, models: [model] };
		const session = new AgentSession({ allowedRoot: process.cwd(), provider, model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("\x1b[Z");
		await waitFor(() => terminal.output.includes("MODEL  faux-model(high)"));

		assert.equal(session.thinkingLevel, "high");
		assert.equal(terminal.output.includes("faux-model(high)"), true);
		mode.stop();
	});

	it("shows token usage through the /usage command", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("question");
		terminal.sendInput("\r");
		await waitFor(() => session.transcript.length === 2);
		terminal.sendInput("/usage");
		terminal.sendInput("\r");
		await waitFor(() => terminal.output.includes("usage: requests=1"));

		assert.equal(terminal.output.includes("context="), true);
		mode.stop();
	});

	it("uses arrow keys to update compaction and Enter to close settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-settings-"));
		try {
			const faux = createFauxProvider({ responses: [] });
			const manager = await SessionManager.create({ filePath: join(root, "session.jsonl"), cwd: root });
			const session = new AgentSession({
				allowedRoot: root,
				provider: faux.provider,
				model: faux.model,
				sessionManager: manager,
			});
			const terminal = new TestTerminal();
			const tui = new TUI(terminal);
			const mode = new InteractiveMode({ session, tui });
			mode.start();

			assert.equal(session.compactionEnabled, true);
			terminal.sendInput("\x13");
			assert.equal(tui.hasOverlay(), true);
			assert.equal(
				tui.render(terminal.columns).some((line) => line.includes("Settings")),
				true,
			);
			assert.equal(
				tui.render(terminal.columns).some((line) => line.includes("›") && line.includes("Context compaction")),
				true,
			);
			terminal.sendInput("\r");
			assert.equal(tui.hasOverlay(), false);
			assert.equal(session.compactionEnabled, true);
			terminal.sendInput("\x13");
			terminal.sendInput("\x1b[C");
			assert.equal(session.compactionEnabled, false);
			terminal.sendInput("\r");
			assert.equal(tui.hasOverlay(), false);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("switches built-in terminal text to Chinese and persists the locale from settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-locale-"));
		try {
			const faux = createFauxProvider({ responses: [] });
			const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
			const terminal = new TestTerminal();
			const tui = new TUI(terminal);
			const mode = new InteractiveMode({ session, tui, agentDir: root });
			mode.start();

			terminal.sendInput("\x13");
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\x1b[C");
			terminal.sendInput("\r");
			await waitFor(() => tui.render(terminal.columns).join("\n").includes("就绪"));
			await waitFor(() => {
				try {
					return JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).locale === "zh-CN";
				} catch {
					return false;
				}
			});
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("handles setting changes attempted during a prompt without throwing from terminal input", async () => {
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [{ type: "success", content: [{ type: "text", text: "a".repeat(100) }] }],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start("question");
		await flush();

		terminal.sendInput("\x13");
		assert.doesNotThrow(() => terminal.sendInput("\r"));
		assert.equal(tui.hasOverlay(), false);
		mode.stop();
	});

	it("does not submit to the old session while a new session is opening", async () => {
		const firstFaux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "old" }] }],
		});
		const secondFaux = createFauxProvider({ responses: [] });
		const firstSession = new AgentSession({
			allowedRoot: process.cwd(),
			provider: firstFaux.provider,
			model: firstFaux.model,
		});
		const secondSession = new AgentSession({
			allowedRoot: process.cwd(),
			provider: secondFaux.provider,
			model: secondFaux.model,
		});
		let resolveSession: ((session: AgentSession) => void) | undefined;
		const opening = new Promise<AgentSession>((resolve) => {
			resolveSession = resolve;
		});
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({
			session: firstSession,
			tui,
			sessions: [{ id: "slow", label: "Slow session", open: () => opening }],
		});
		mode.start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		terminal.sendInput("must not run");
		terminal.sendInput("\r");
		await flush();

		assert.equal(firstSession.transcript.length, 0);
		resolveSession?.(secondSession);
		await waitFor(() => terminal.output.includes("session=slow"));
		mode.stop();
	});

	it("keeps the workspace chooser frame outside Compose in a short terminal", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-at-"));
		try {
			for (const directory of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
				mkdirSync(join(root, directory));
			}
			const faux = createFauxProvider({ responses: [] });
			const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
			const terminal = new TestTerminal(false, 80, 10);
			const tui = new TUI(terminal);
			const mode = new InteractiveMode({ session, tui });
			mode.start();

			terminal.sendInput("@");
			await waitFor(() => tui.hasOverlay());
			const frame = tui.render(terminal.columns);
			const editorTop = frame.findIndex((line) => line.includes(" Compose "));
			const editorBottom = frame.findIndex((line, index) => index > editorTop && line.startsWith("└"));
			const menuRows = frame
				.map((line, index) => ({ line, index }))
				.filter(({ line }) => line.includes("Suggestions") || line.includes("›") || line.includes("alpha/"));
			assert.equal(
				frame.some((line) => line.includes("Suggestions")),
				true,
			);
			assert.equal(
				frame.some((line) => line.includes("›")),
				true,
			);
			assert.equal(
				frame.some((line) => line.includes("alpha/")),
				true,
			);
			assert.equal(
				menuRows.every(({ index }) => index < editorTop || index > editorBottom),
				true,
			);
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows slash autocomplete without sending the completed command to the provider", async () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("/mo");
		terminal.sendInput("\t");
		await waitFor(() => tui.hasOverlay());
		await waitFor(() => terminal.output.includes("Open the model selector"));
		assert.equal(terminal.output.includes("Suggestions"), true);
		assert.equal(terminal.output.includes("›"), true);
		assert.equal(terminal.output.includes("Open the model selector"), true);
		const frame = tui.render(terminal.columns);
		const suggestionsRow = frame.findIndex((line) => line.includes("Suggestions"));
		assert.equal(
			frame.slice(suggestionsRow, suggestionsRow + 9).some((line) => line.includes("└")),
			true,
		);
		terminal.sendInput("\r");
		assert.equal(tui.hasOverlay(), false);
		terminal.sendInput("\r");
		await flush();

		assert.equal(tui.hasOverlay(), true);
		assert.equal(session.transcript.length, 0);
		mode.stop();
	});

	it("opens slash autocomplete on slash, includes extension commands, and keeps the menu outside the editor", async () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const host = new ExtensionHost({ cwd: process.cwd(), mode: "interactive", projectTrusted: true });
		await host.registerExtension("test", (api) => {
			api.registerCommand({
				name: "greet",
				description: "Extension greeting",
				handler: () => {},
			});
		});
		const terminal = new TestTerminal(false, 80, 10);
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui, extensionHost: host });
		mode.start();

		terminal.sendInput("/g");
		await waitFor(
			() => tui.hasOverlay() && tui.render(terminal.columns).some((line) => line.includes("Extension greeting")),
		);

		const frame = tui.render(terminal.columns);
		const menuRow = frame.findIndex((line) => line.includes("Extension greeting"));
		const editorTop = frame.findIndex((line) => line.includes(" Compose "));
		const editorBottom = frame.findIndex((line, index) => index > editorTop && line.startsWith("└"));
		assert.equal(menuRow >= 0, true);
		assert.equal(menuRow < editorTop || menuRow > editorBottom, true);
		mode.stop();
	});

	it("includes loaded skills in slash autocomplete and applies the skill command form", async () => {
		const skillDirectory = mkdtempSync(join(tmpdir(), "di-code-interactive-skill-"));
		try {
			const skillPath = join(skillDirectory, "SKILL.md");
			writeFileSync(
				skillPath,
				"---\nname: review\ndescription: Review code changes\n---\nInspect the selected changes before responding.",
			);
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "reviewed" }] }],
			});
			const session = new AgentSession({
				allowedRoot: process.cwd(),
				provider: faux.provider,
				model: faux.model,
				skills: [
					{
						kind: "skill",
						name: "review",
						description: "Review code changes",
						filePath: skillPath,
						baseDir: skillDirectory,
						scope: "global",
						disableModelInvocation: false,
					},
				],
			});
			const terminal = new TestTerminal();
			const tui = new TUI(terminal);
			const mode = new InteractiveMode({ session, tui });
			mode.start();

			terminal.sendInput("/skill:r");
			await waitFor(() => terminal.output.includes("Review code changes"));
			terminal.sendInput("\t");
			await waitFor(() => tui.render(terminal.columns).join("\n").includes("/skill:review"));
			terminal.sendInput("inspect this");
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);

			const request = session.transcript[0];
			assert.equal(request?.role, "user");
			if (request?.role !== "user") throw new Error("Expected the skill command to produce a user message.");
			const prompt = request.content.find((content) => content.type === "text")?.text;
			assert.equal(prompt?.includes('<explicit_skill name="review"'), true);
			assert.equal(prompt?.includes("inspect this"), true);
			mode.stop();
		} finally {
			rmSync(skillDirectory, { recursive: true, force: true });
		}
	});

	it("uses Alt+S to steer a running AgentSession", async () => {
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [
				{ type: "success", content: [{ type: "text", text: "first response that stays active" }] },
				{ type: "success", content: [{ type: "text", text: "revised response" }] },
			],
		});
		const requestedMessages: Message[][] = [];
		let releaseFirstResponse: (() => void) | undefined;
		const firstResponseReleased = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		let firstChunkSent = false;
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				requestedMessages.push(structuredClone(context.messages));
				const stream = faux.provider.stream(model, context, options);
				if (requestedMessages.length !== 1) return stream;
				return {
					async *[Symbol.asyncIterator]() {
						for await (const event of stream) {
							yield event;
							if (event.type === "text_delta") {
								firstChunkSent = true;
								await firstResponseReleased;
							}
						}
					},
					result: () => stream.result(),
				};
			},
		};
		const session = new AgentSession({ allowedRoot: process.cwd(), provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("start");
		terminal.sendInput("\r");
		await waitFor(() => firstChunkSent);
		terminal.sendInput("change the plan");
		terminal.sendInput("\x1bs");
		await waitFor(() => tui.render(terminal.columns).join("\n").includes("steer: change the plan"));
		releaseFirstResponse?.();
		await waitFor(() => session.transcript.length === 4);

		assert.equal(requestedMessages.length, 2);
		const steering = requestedMessages[1]?.at(-1);
		assert.equal(steering?.role, "user");
		if (steering?.role !== "user") throw new Error("Expected steering to be a user message.");
		assert.deepEqual(steering.content, [{ type: "text", text: "change the plan" }]);
		assert.equal(tui.render(terminal.columns).join("\n").includes("revised response"), true);
		mode.stop();
	});

	it("uses /steer to steer a running AgentSession", async () => {
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [
				{ type: "success", content: [{ type: "text", text: "first response that stays active" }] },
				{ type: "success", content: [{ type: "text", text: "short revised response" }] },
			],
		});
		const requestedMessages: Message[][] = [];
		let releaseFirstResponse: (() => void) | undefined;
		const firstResponseReleased = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		let firstChunkSent = false;
		const provider: Provider = {
			...faux.provider,
			stream(model, context, options) {
				requestedMessages.push(structuredClone(context.messages));
				const stream = faux.provider.stream(model, context, options);
				if (requestedMessages.length !== 1) return stream;
				return {
					async *[Symbol.asyncIterator]() {
						for await (const event of stream) {
							yield event;
							if (event.type === "text_delta") {
								firstChunkSent = true;
								await firstResponseReleased;
							}
						}
					},
					result: () => stream.result(),
				};
			},
		};
		const session = new AgentSession({ allowedRoot: process.cwd(), provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("start");
		terminal.sendInput("\r");
		await waitFor(() => firstChunkSent);
		terminal.sendInput("/steer answer briefly");
		terminal.sendInput("\r");
		await waitFor(() => tui.render(terminal.columns).join("\n").includes("steer: answer briefly"));
		releaseFirstResponse?.();
		await waitFor(() => session.transcript.length === 4);

		assert.equal(requestedMessages.length, 2);
		const steering = requestedMessages[1]?.at(-1);
		assert.equal(steering?.role, "user");
		if (steering?.role !== "user") throw new Error("Expected steering to be a user message.");
		assert.deepEqual(steering.content, [{ type: "text", text: "answer briefly" }]);
		assert.equal(tui.render(terminal.columns).join("\n").includes("short revised response"), true);
		mode.stop();
	});

	it("rejects empty and idle /steer commands without clearing the editor", async () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();

		terminal.sendInput("/steer");
		terminal.sendInput("\r");
		await flush();

		assert.equal(tui.render(terminal.columns).join("\n").includes("/steer"), true);
		assert.equal(tui.render(terminal.columns).join("\n").includes("Steering content must not be empty."), true);
		terminal.sendInput("\x15");
		terminal.sendInput("/steer wait for me");
		terminal.sendInput("\r");
		await flush();

		assert.equal(session.transcript.length, 0);
		assert.equal(tui.render(terminal.columns).join("\n").includes("/steer wait for me"), true);
		assert.equal(
			tui.render(terminal.columns).join("\n").includes("Steering is only available while a prompt is running."),
			true,
		);
		mode.stop();
	});

	it("queues prompts in FIFO order and retries the last failure", async () => {
		const faux = createFauxProvider({
			chunkSize: 1,
			responses: [
				{ type: "failure", errorMessage: "temporary" },
				{ type: "success", content: [{ type: "text", text: "retried" }] },
				{ type: "success", content: [{ type: "text", text: "second" }] },
				{ type: "success", content: [{ type: "text", text: "third" }] },
			],
		});
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();
		terminal.sendInput("first");
		terminal.sendInput("\r");
		await waitFor(() => session.transcript.length === 2);
		terminal.sendInput("\x12");
		await waitFor(() => session.transcript.length === 4);
		terminal.sendInput("second");
		terminal.sendInput("\r");
		terminal.sendInput("third");
		terminal.sendInput("\r");
		await flush();
		const queuedFrame = tui.render(terminal.columns).join("\n");
		assert.equal(queuedFrame.includes("Queue (1)"), true);
		assert.equal(queuedFrame.includes("third"), true);
		await waitFor(() => session.transcript.length === 8);
		assert.equal(session.transcript.at(-1)?.role, "assistant");
		mode.stop();
	});

	it("lists /tree in help and restores a selected historical user prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "di-code-interactive-tree-"));
		try {
			const faux = createFauxProvider({
				responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }],
			});
			const manager = await SessionManager.create({ filePath: join(root, "session.jsonl"), cwd: root });
			const session = new AgentSession({
				allowedRoot: root,
				provider: faux.provider,
				model: faux.model,
				sessionManager: manager,
			});
			const terminal = new TestTerminal(false, 120, 10);
			const tui = new TUI(terminal);
			const mode = new InteractiveMode({ session, tui });
			mode.start();
			terminal.sendInput("question");
			terminal.sendInput("\r");
			await waitFor(() => session.transcript.length === 2);
			await manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "question\ncontinued" }],
				timestamp: 3,
			});

			terminal.sendInput("/help");
			terminal.sendInput("\r");
			await waitFor(() => terminal.output.includes("/tree"));
			terminal.sendInput("/tree");
			terminal.sendInput("\r");
			await waitFor(() => tui.hasOverlay());
			await waitFor(() => {
				const frame = tui.render(terminal.columns).join("\n");
				return (
					frame.includes("›") &&
					frame.includes("question continued") &&
					frame.includes("Summarize + branch") &&
					frame.includes("└")
				);
			});
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			await waitFor(() => !tui.hasOverlay());
			await waitFor(() => tui.render(terminal.columns).join("\n").includes("tree="));
			mode.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("interactive CLI parsing", () => {
	it("allows interactive mode to start without an initial prompt", async () => {
		const { parseCliArgs } = await import("../src/cli.ts");
		assert.deepEqual(parseCliArgs(["--interactive"]), { kind: "run", mode: "interactive", prompt: "" });
		assert.throws(() => parseCliArgs(["--mode", "print"]), /A prompt is required/);
		assert.throws(() => parseCliArgs(["--mode", "json"]), /A prompt is required/);
	});

	it("accepts interactive mode and rejects print conflicts", async () => {
		const { parseCliArgs } = await import("../src/cli.ts");
		assert.deepEqual(parseCliArgs(["--mode", "interactive", "hello"]), {
			kind: "run",
			mode: "interactive",
			prompt: "hello",
		});
		assert.deepEqual(parseCliArgs(["--interactive", "hello"]), { kind: "run", mode: "interactive", prompt: "hello" });
		assert.throws(
			() => parseCliArgs(["--print", "--mode", "interactive", "hello"]),
			/Cannot combine --print with --mode interactive/,
		);
	});
});
