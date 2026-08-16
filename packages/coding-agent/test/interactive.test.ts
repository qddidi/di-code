import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, type Provider } from "@di-code/ai";
import type { Component, Terminal } from "@di-code/tui";
import { CURSOR_MARKER, TUI } from "@di-code/tui";
import { describe, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession } from "../src/core/session.ts";
import { ExtensionHost } from "../src/extensions/runtime.ts";
import { InteractiveMode, InteractiveProjection } from "../src/modes/interactive.ts";
import { InteractiveChat, type InteractiveViewState } from "../src/modes/interactive-components.ts";

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

	it("keeps the loading spinner visible while streaming before agent_end", () => {
		const projection = new InteractiveProjection();
		const readState = (): InteractiveViewState => ({ ...projection.state, model: "faux-model", theme: "dark" });
		const chat = new InteractiveChat(readState);

		projection.apply({ type: "agent_start" });
		projection.apply({ type: "message_update", event: { type: "text_delta", contentIndex: 0, delta: "partial" } });

		assert.equal(projection.state.busy, true);
		assert.equal(chat.render(80).join("\n").includes("Thinking"), true);
		const firstFrame = projection.state.spinnerFrame;
		assert.equal(projection.advanceSpinner(), true);
		assert.notEqual(projection.state.spinnerFrame, firstFrame);
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

		assert.equal(terminal.output.includes("Assistant"), true);
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

		assert.equal(terminal.output.includes("You"), true);
		assert.equal(terminal.output.includes("Assistant"), true);
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

	it("uses a SettingsList overlay to update compaction", async () => {
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
			terminal.sendInput("\r");
			assert.equal(session.compactionEnabled, false);
			terminal.sendInput("\x1b");
			assert.equal(tui.hasOverlay(), false);
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
		assert.equal(terminal.output.includes("Open the model selector"), true);
		terminal.sendInput("\r");
		assert.equal(tui.hasOverlay(), false);
		terminal.sendInput("\r");
		await flush();

		assert.equal(tui.hasOverlay(), true);
		assert.equal(session.transcript.length, 0);
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
