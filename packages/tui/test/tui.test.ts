import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "../src/tui.ts";
import { EmulatedTerminal } from "./emulated-terminal.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Probe implements Component {
	readonly widths: number[] = [];
	invalidateCount = 0;
	lines: string[];

	constructor(lines: string[] = []) {
		this.lines = lines;
	}

	render(width: number): string[] {
		this.widths.push(width);
		return [...this.lines];
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}
}

class FocusProbe extends Probe implements Focusable {
	focused = false;
	readonly inputs: string[] = [];

	override render(width: number): string[] {
		const [line = ""] = super.render(width);
		return [this.focused ? `${line}${CURSOR_MARKER}` : line];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

async function flushRender(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("Container", () => {
	it("renders children in order with the same width", () => {
		const container = new Container();
		const first = new Probe(["first"]);
		const second = new Probe(["second", "third"]);
		container.addChild(first);
		container.addChild(second);

		assert.deepEqual(container.render(20), ["first", "second", "third"]);
		assert.deepEqual(first.widths, [20]);
		assert.deepEqual(second.widths, [20]);
	});

	it("removes, clears, and invalidates mounted children", () => {
		const container = new Container();
		const first = new Probe(["first"]);
		const second = new Probe(["second"]);
		container.addChild(first);
		container.addChild(second);
		container.removeChild(first);
		container.invalidate();

		assert.equal(first.invalidateCount, 0);
		assert.equal(second.invalidateCount, 1);
		container.clear();
		assert.deepEqual(container.render(20), []);
	});
});

describe("TUI focus", () => {
	it("moves focus and routes input only to the focused component", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const first = new FocusProbe(["first"]);
		const second = new FocusProbe(["second"]);
		tui.addChild(first);
		tui.addChild(second);
		tui.setFocus(first);
		tui.start();
		await flushRender();
		terminal.sendInput("a");
		await flushRender();

		assert.equal(first.focused, true);
		assert.deepEqual(first.inputs, ["a"]);
		assert.deepEqual(second.inputs, []);

		tui.setFocus(second);
		terminal.sendInput("b");
		await flushRender();
		assert.equal(first.focused, false);
		assert.equal(second.focused, true);
		assert.deepEqual(second.inputs, ["b"]);
		tui.stop();
	});

	it("rejects duplicate start and makes stop before start harmless", () => {
		const tui = new TUI(new VirtualTerminal());
		tui.stop();
		tui.start();
		assert.throws(() => tui.start(), { message: "TUI is already started" });
		tui.stop();
	});
});

describe("TUI frame contract", () => {
	it("clears the final frame before returning terminal control", () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		tui.addChild(new Probe(["workspace"]));
		tui.start();
		terminal.clearOutput();

		tui.stop();

		assert.equal(terminal.output.includes("\x1b[2J\x1b[H"), true);
		assert.equal(terminal.output.includes("\x1b[?25h"), true);
	});

	it("can replace the workspace with a final transcript before stopping", () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		tui.addChild(new Probe(["workspace"]));
		tui.start();
		terminal.clearOutput();

		tui.stop({ finalLines: ["older message", "latest message"] });

		assert.equal(terminal.output.includes("older message"), true);
		assert.equal(terminal.output.includes("latest message"), true);
		assert.equal(terminal.output.includes("\r\n\x1b[?25h"), true);
	});

	it("hides the hardware cursor by default while keeping its position for IME", async () => {
		const terminal = new VirtualTerminal(10, 4);
		const tui = new TUI(terminal);
		const input = new FocusProbe(["A界"]);
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();

		assert.equal(terminal.output.includes(CURSOR_MARKER), false);
		assert.equal(terminal.output.endsWith("\r\x1b[3C\x1b[?25l"), true);
		terminal.clearOutput();
		tui.setFocus(null);
		await flushRender();
		assert.equal(terminal.output.includes("\x1b[?25l"), true);
		tui.stop();
	});

	it("shows the hardware cursor when explicitly enabled", () => {
		const terminal = new VirtualTerminal(10, 4);
		const tui = new TUI(terminal, true);
		const input = new FocusProbe(["A界"]);
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();

		assert.equal(terminal.output.endsWith("\r\x1b[3C\x1b[?25h"), true);
		tui.stop();
	});

	it("updates hardware cursor visibility while running", async () => {
		const terminal = new VirtualTerminal(10, 4);
		const tui = new TUI(terminal);
		const input = new FocusProbe(["input"]);
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		terminal.clearOutput();

		tui.setShowHardwareCursor(true);
		await flushRender();
		assert.equal(tui.getShowHardwareCursor(), true);
		assert.equal(terminal.output.includes("\x1b[?25h"), true);

		terminal.clearOutput();
		tui.setShowHardwareCursor(false);
		assert.equal(tui.getShowHardwareCursor(), false);
		assert.equal(terminal.output.includes("\x1b[?25l"), true);
		tui.stop();
	});

	it("resets SGR and hyperlink styles at every line boundary", () => {
		const terminal = new VirtualTerminal(10, 4);
		const tui = new TUI(terminal);
		tui.addChild(new Probe(["\x1b[31mred", "plain"]));
		tui.start();

		assert.equal(terminal.output.includes("red\x1b[0m\x1b]8;;\x07\r\nplain"), true);
		tui.stop();
	});

	it("rejects embedded line breaks and over-wide lines", () => {
		const lineBreakTui = new TUI(new VirtualTerminal(5, 4));
		lineBreakTui.addChild(new Probe(["a\nb"]));
		assert.throws(() => lineBreakTui.start(), { message: "Component line 1 contains a line break" });

		const wideTui = new TUI(new VirtualTerminal(4, 4));
		wideTui.addChild(new Probe(["abc界"]));
		assert.throws(() => wideTui.start(), {
			message: "Component line 1 is 5 columns wide, maximum is 4",
		});
	});

	it("rejects more than one cursor marker in a frame", () => {
		const tui = new TUI(new VirtualTerminal());
		tui.addChild(new Probe([`a${CURSOR_MARKER}`, `b${CURSOR_MARKER}`]));
		assert.throws(() => tui.start(), { message: "Frame contains more than one cursor marker" });
	});
});

describe("TUI differential rendering", () => {
	it("scrolls a growing long frame without clearing the terminal", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TUI(terminal);
		const probe = new Probe(["history 0", "history 1", "history 2", "editor", "footer"]);
		tui.addChild(probe);
		tui.start();
		terminal.clearOutput();

		probe.lines = [...probe.lines, "new history"];
		tui.requestRender();
		await flushRender();

		assert.equal(terminal.output.includes("\x1b[2J\x1b[H"), false);
		assert.equal(terminal.output.includes("\r\n"), true);
		assert.equal(terminal.output.includes("new history"), true);
		tui.stop();
	});

	it("rewrites only the changed visible line in a long frame", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TUI(terminal);
		const probe = new Probe(["history 0", "history 1", "stream A", "editor", "footer"]);
		tui.addChild(probe);
		tui.start();
		terminal.clearOutput();

		probe.lines = ["history 0", "history 1", "stream B", "editor", "footer"];
		tui.requestRender();
		await flushRender();

		assert.equal(terminal.output.split("\x1b[2K").length - 1, 1);
		assert.equal(terminal.output.includes("history 1"), false);
		assert.equal(terminal.output.includes("stream B"), true);
		tui.stop();
	});

	it("keeps committed scrollback immutable when an offscreen history line changes", async () => {
		const terminal = new EmulatedTerminal(20, 4);
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const probe = new Probe(lines);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		probe.lines = ["changed history", ...lines.slice(1)];
		tui.requestRender();
		await flushRender();
		await terminal.flush();

		assert.deepEqual(terminal.getScrollBuffer(), lines);
		assert.deepEqual(terminal.getViewport(), probe.lines.slice(-terminal.rows));
		tui.stop();
	});

	it("does not replay committed history when scrollback clearing is unsupported", async () => {
		const terminal = new EmulatedTerminal(20, 4, { ignoreClearScrollback: true });
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const probe = new Probe(lines);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		probe.lines = ["changed history", ...lines.slice(1)];
		tui.requestRender();
		await flushRender();
		await terminal.flush();

		const buffer = terminal.getScrollBuffer();
		assert.equal(buffer.filter((line) => line === "history 1").length, 1);
		assert.deepEqual(terminal.getViewport(), probe.lines.slice(-terminal.rows));
		tui.stop();
	});

	it("rebuilds only the writable viewport when a full redraw is forced", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		tui.addChild(new Probe(lines));
		tui.start();
		terminal.clearOutput();

		tui.requestRender(true);
		await flushRender();

		assert.equal(terminal.output.includes("\x1b[3J"), false);
		assert.equal(terminal.output.includes("history 0"), false);
		assert.equal(terminal.output.includes("history 8"), true);
		assert.equal(terminal.output.includes("history 11"), true);
		tui.stop();
	});

	it("keeps one committed header across mixed long-frame transitions", async () => {
		const terminal = new EmulatedTerminal(24, 6, { ignoreClearScrollback: true });
		const tui = new TUI(terminal);
		const history = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const tail = ["compose", "editor", "status", "footer"];
		const probe = new Probe(["HEADER", ...history, "stream 0", ...tail]);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		const frames = [
			["HEADER", "changed history", ...history.slice(1), "stream 1", ...tail],
			["HEADER", ...history.slice(0, 5), "stream merged", ...tail],
			["HEADER", ...history, "stream 1", "stream 2", "stream 3", ...tail],
		];
		for (const frame of frames) {
			probe.lines = frame;
			tui.requestRender();
			await flushRender();
			await terminal.flush();

			assert.equal(terminal.getScrollBuffer().filter((line) => line === "HEADER").length, 1);
			assert.deepEqual(terminal.getViewport(), frame.slice(-terminal.rows));
		}
		tui.stop();
	});

	it("preserves one copy of scrollback and clears vacated rows when a long frame shrinks", async () => {
		const terminal = new EmulatedTerminal(20, 4);
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const probe = new Probe(lines);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		probe.lines = lines.slice(0, 10);
		tui.requestRender();
		await flushRender();
		await terminal.flush();

		const buffer = terminal.getScrollBuffer();
		assert.deepEqual(buffer.slice(0, probe.lines.length), probe.lines);
		assert.equal(
			buffer.slice(probe.lines.length).every((line) => line === ""),
			true,
		);
		assert.equal(buffer.filter((line) => line === "history 0").length, 1);
		tui.stop();
	});

	it("does not replay long streaming history when visible content shrinks before the footer", async () => {
		const terminal = new EmulatedTerminal(24, 6, { ignoreClearScrollback: true });
		const tui = new TUI(terminal);
		const history = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const footer = ["composer", "editor", "status", "footer"];
		const probe = new Probe([...history, "stream first", "stream second", ...footer]);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		probe.lines = [...history, "stream merged", ...footer];
		tui.requestRender();
		await flushRender();
		await terminal.flush();

		const buffer = terminal.getScrollBuffer();
		assert.equal(buffer.filter((line) => line === "history 0").length, 1);
		assert.equal(buffer.filter((line) => line === "history 11").length, 1);
		assert.equal(
			terminal.getViewport().some((line) => line === "stream merged"),
			true,
		);
		tui.stop();
	});

	it("preserves every line when a long frame grows by more than one viewport", async () => {
		const terminal = new EmulatedTerminal(20, 4, { ignoreClearScrollback: true });
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 8 }, (_, index) => `history ${index}`);
		const probe = new Probe([...lines, "editor", "footer"]);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		const added = Array.from({ length: 5 }, (_, index) => `new ${index}`);
		probe.lines = [...lines, ...added, "editor", "footer"];
		tui.requestRender();
		await flushRender();
		await terminal.flush();

		assert.deepEqual(terminal.getScrollBuffer(), probe.lines);
		tui.stop();
	});

	it("coalesces stream updates that arrive within one render interval", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TUI(terminal);
		const probe = new Probe(["initial"]);
		tui.addChild(probe);
		tui.start();

		probe.lines = ["first delta"];
		tui.requestRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
		probe.lines = ["second delta"];
		tui.requestRender();
		await flushRender();

		assert.deepEqual(probe.widths, [20, 20]);
		assert.equal(terminal.output.includes("first delta"), false);
		assert.equal(terminal.output.includes("second delta"), true);
		tui.stop();
	});

	it("prints final long-frame lines once when stopping", async () => {
		const terminal = new EmulatedTerminal(20, 4, { ignoreClearScrollback: true });
		const tui = new TUI(terminal);
		const lines = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const probe = new Probe(lines);
		tui.addChild(probe);
		tui.start();
		await terminal.flush();

		tui.stop({ finalLines: lines });
		await terminal.flush();

		assert.deepEqual(terminal.getScrollBuffer(), [...lines, ""]);
	});

	it("coalesces requests and writes nothing for an unchanged frame", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const probe = new Probe(["stable"]);
		tui.addChild(probe);
		tui.start();
		terminal.clearOutput();

		tui.requestRender();
		tui.requestRender();
		tui.requestRender();
		await flushRender();
		assert.equal(terminal.output, "");
		assert.deepEqual(probe.widths, [20, 20]);
		tui.stop();
	});

	it("rewrites only the changed line without clearing the screen", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const probe = new Probe(["zero", "old", "two"]);
		tui.addChild(probe);
		tui.start();
		terminal.clearOutput();

		probe.lines = ["zero", "new", "two"];
		tui.requestRender();
		await flushRender();

		assert.equal(terminal.output.includes("\x1b[2J"), false);
		assert.equal(terminal.output.includes("new"), true);
		assert.equal(terminal.output.includes("zero"), false);
		assert.equal(terminal.output.includes("two"), false);
		tui.stop();
	});

	it("clears lines removed by a shrinking frame", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const probe = new Probe(["zero", "one", "two"]);
		tui.addChild(probe);
		tui.start();
		terminal.clearOutput();

		probe.lines = ["zero"];
		tui.requestRender();
		await flushRender();

		assert.equal(terminal.output.includes("\x1b[2J"), false);
		assert.equal(terminal.output.split("\x1b[2K").length - 1, 2);
		tui.stop();
	});

	it("invalidates and fully redraws after a terminal resize", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const probe = new Probe(["content"]);
		tui.addChild(probe);
		tui.start();
		terminal.clearOutput();

		terminal.resize(10, 4);
		await flushRender();

		assert.equal(probe.invalidateCount, 1);
		assert.equal(probe.widths.at(-1), 10);
		assert.equal(terminal.output.includes("\x1b[2J\x1b[H"), true);
		tui.stop();
	});

	it("does not redraw when a resize notification keeps the same dimensions", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		tui.addChild(new Probe(["stable"]));
		tui.start();
		terminal.clearOutput();

		terminal.notifyResize();
		await flushRender();

		assert.equal(terminal.output, "");
		tui.stop();
	});
});
