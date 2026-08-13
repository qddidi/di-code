import assert from "node:assert/strict";
import { createFauxProvider } from "@di-code/ai";
import type { Terminal } from "@di-code/tui";
import { CURSOR_MARKER, TUI } from "@di-code/tui";
import { describe, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { InteractiveMode, InteractiveProjection } from "../src/modes/interactive.ts";

class TestTerminal implements Terminal {
	private input?: (data: string) => void;
	private readonly writes: string[] = [];
	readonly columns = 80;
	readonly rows = 24;
	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {
		this.input = undefined;
	}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(lines: number): void {
		if (lines !== 0) this.write(`move:${lines}`);
	}
	hideCursor(): void {}
	showCursor(): void {}
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
			message: preview("hel"),
		});

		assert.deepEqual(projection.state.messages, ["hello"]);
		assert.equal(projection.state.streamingText, "hel");
		assert.equal(projection.state.busy, true);
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

	it("commits final assistant text and clears streaming state", () => {
		const projection = new InteractiveProjection();
		projection.apply({ type: "agent_start" });
		projection.apply({
			type: "message_update",
			event: { type: "text_delta", contentIndex: 0, delta: "done" },
			message: preview("done"),
		});
		projection.apply({ type: "message_end", message: assistantMessage("done") });
		projection.apply({ type: "agent_end", messages: [] });

		assert.deepEqual(projection.state.messages, ["done"]);
		assert.equal(projection.state.streamingText, "");
		assert.equal(projection.state.busy, false);
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

describe("InteractiveMode", () => {
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

		assert.equal(session.transcript.at(-1)?.role, "assistant");
		assert.equal(terminal.output.includes("hello from model"), true);
		assert.equal(terminal.output.includes(CURSOR_MARKER), false);
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

	it("opens and navigates keyboard selectors", async () => {
		const faux = createFauxProvider({ responses: [] });
		const session = new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model });
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const mode = new InteractiveMode({ session, tui });
		mode.start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await flush();
		assert.equal(terminal.output.includes("session=new-session"), true);
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
		await waitFor(() => session.transcript.length === 8);
		assert.equal(session.transcript.at(-1)?.role, "assistant");
		mode.stop();
	});
});

describe("interactive CLI parsing", () => {
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
