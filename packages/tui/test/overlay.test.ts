import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class OverlayProbe implements Component, Focusable {
	focused = false;
	readonly widths: number[] = [];
	readonly inputs: string[] = [];
	invalidateCount = 0;
	readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		this.widths.push(width);
		return this.lines.map((line, index) => (index === 0 && this.focused ? `${line}${CURSOR_MARKER}` : line));
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}
}

async function flushRender(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("TUI overlay layout", () => {
	it("composites a centered overlay even when base content is short", () => {
		const tui = new TUI(new VirtualTerminal(12, 5));
		tui.addChild(new OverlayProbe(["abcdefghijkl"]));
		tui.showOverlay(new OverlayProbe(["OK"]), { width: 4, anchor: "center" });

		const lines = tui.render(12);

		assert.equal(lines.length, 3);
		assert.equal(lines[2]?.includes("OK"), true);
		assert.equal(visibleWidth(lines[2] ?? ""), 12);
	});

	it("anchors an overlay in the current viewport when base content is taller than the terminal", () => {
		const tui = new TUI(new VirtualTerminal(12, 4));
		tui.addChild(new OverlayProbe(Array.from({ length: 10 }, (_, index) => `history ${index}`)));
		tui.showOverlay(new OverlayProbe(["OK"]), { width: 4, anchor: "center" });

		const lines = tui.render(12);

		assert.equal(lines.length, 10);
		assert.equal(
			lines.slice(-4).some((line) => line.includes("OK")),
			true,
		);
	});

	it("places an anchored non-capturing overlay below its input and flips above when needed", () => {
		const below = new TUI(new VirtualTerminal(16, 6));
		below.addChild(new OverlayProbe(Array.from({ length: 6 }, (_, index) => `history ${index}`)));
		below.showOverlay(new OverlayProbe(["choice one", "choice two"]), {
			width: 12,
			placement: { anchorRow: 0, preferred: "below" },
			nonCapturing: true,
		});
		const belowLines = below.render(16);
		assert.equal(belowLines[0]?.includes("history 0"), true);
		assert.equal(belowLines[1]?.includes("choice one"), true);
		assert.equal(belowLines[2]?.includes("choice two"), true);

		const above = new TUI(new VirtualTerminal(16, 6));
		above.addChild(new OverlayProbe(Array.from({ length: 10 }, (_, index) => `history ${index}`)));
		above.showOverlay(new OverlayProbe(["choice one", "choice two"]), {
			width: 12,
			placement: { anchorRow: 9, preferred: "below" },
			nonCapturing: true,
		});
		const aboveLines = above.render(16);

		assert.equal(aboveLines[9]?.includes("history 9"), true);
		assert.equal(aboveLines[7]?.includes("choice one"), true);
		assert.equal(aboveLines[8]?.includes("choice two"), true);
	});

	it("keeps a placement overlay above an editor whose logical anchor is outside the viewport", () => {
		const tui = new TUI(new VirtualTerminal(16, 6));
		tui.addChild(new OverlayProbe(Array.from({ length: 20 }, (_, index) => `history ${index}`)));
		tui.showOverlay(new OverlayProbe(["choice one", "choice two"]), {
			width: 12,
			placement: { anchorRow: 30, avoidStartRow: 16, preferred: "below" },
			nonCapturing: true,
		});

		const lines = tui.render(16);

		assert.equal(lines[14]?.includes("choice one"), true);
		assert.equal(lines[15]?.includes("choice two"), true);
		assert.equal(lines[18]?.includes("choice one"), false);
	});

	it("resolves percentage width and maximum height", () => {
		const tui = new TUI(new VirtualTerminal(20, 6));
		const overlay = new OverlayProbe(["one", "two", "three"]);
		tui.showOverlay(overlay, { width: "50%", maxHeight: 2, anchor: "top-left" });

		const lines = tui.render(20);

		assert.deepEqual(overlay.widths, [10]);
		assert.equal(lines.length, 2);
		assert.equal(lines[0]?.includes("one"), true);
		assert.equal(lines[1]?.includes("two"), true);
		assert.equal(
			lines.some((line) => line.includes("three")),
			false,
		);
	});

	it("preserves an opted-in overlay footer when maximum height truncates its content", () => {
		const tui = new TUI(new VirtualTerminal(20, 6));
		const overlay = new OverlayProbe(["┌────┐", "│ one│", "│ two│", "└────┘"]);
		tui.showOverlay(overlay, { width: 8, maxHeight: 3, anchor: "top-left", preserveLastLine: true });

		const lines = tui.render(20);

		assert.equal(lines[0]?.includes("┌────┐"), true);
		assert.equal(lines[1]?.includes("│ one│"), true);
		assert.equal(lines[2]?.includes("└────┘"), true);
		assert.equal(
			lines.some((line) => line.includes("│ two│")),
			false,
		);
	});

	it("clamps an oversized overlay inside a narrow terminal", () => {
		const tui = new TUI(new VirtualTerminal(6, 4));
		tui.addChild(new OverlayProbe(["ab界cd"]));
		const overlay = new OverlayProbe(["中X"]);
		tui.showOverlay(overlay, { width: 10, margin: 1, anchor: "top-center" });

		const lines = tui.render(6);
		const line = lines.find((candidate) => candidate.includes("中X")) ?? "";

		assert.deepEqual(overlay.widths, [4]);
		assert.equal(visibleWidth(line), 6);
		assert.equal(lines.length, 2);
	});

	it("isolates overlay styles from the base suffix", () => {
		const tui = new TUI(new VirtualTerminal(8, 3));
		tui.addChild(new OverlayProbe(["abcdefgh"]));
		tui.showOverlay(new OverlayProbe(["\x1b[31mXX"]), { width: 2, anchor: "top-center" });

		const [line = ""] = tui.render(8);

		assert.equal(visibleWidth(line), 8);
		assert.equal(line.includes("\x1b[31mXX"), true);
		assert.equal(line.includes("\x1b[0m\x1b]8;;\x07fgh"), true);
		assert.equal(line.endsWith("fgh\x1b[0m"), true);
	});
});

describe("TUI overlay focus lifecycle", () => {
	it("captures focus and restores the base focus when hidden", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const base = new OverlayProbe(["base"]);
		const overlay = new OverlayProbe(["modal"]);
		tui.addChild(base);
		tui.setFocus(base);
		const handle = tui.showOverlay(overlay, { width: 10 });
		tui.start();

		terminal.sendInput("a");
		await flushRender();
		handle.hide();
		terminal.sendInput("b");
		await flushRender();

		assert.deepEqual(overlay.inputs, ["a"]);
		assert.deepEqual(base.inputs, ["b"]);
		assert.equal(base.focused, true);
		tui.stop();
	});

	it("restores nested modal focus in LIFO order", () => {
		const tui = new TUI(new VirtualTerminal());
		const base = new OverlayProbe(["base"]);
		const first = new OverlayProbe(["first"]);
		const second = new OverlayProbe(["second"]);
		tui.addChild(base);
		tui.setFocus(base);
		const firstHandle = tui.showOverlay(first);
		const secondHandle = tui.showOverlay(second);

		assert.equal(second.focused, true);
		secondHandle.hide();
		assert.equal(first.focused, true);
		firstHandle.hide();
		assert.equal(base.focused, true);
	});

	it("retargets descendant focus when a lower overlay is removed first", () => {
		const tui = new TUI(new VirtualTerminal());
		const base = new OverlayProbe(["base"]);
		const first = new OverlayProbe(["first"]);
		const second = new OverlayProbe(["second"]);
		tui.setFocus(base);
		const firstHandle = tui.showOverlay(first);
		const secondHandle = tui.showOverlay(second);

		firstHandle.hide();
		assert.equal(second.focused, true);
		secondHandle.hide();

		assert.equal(base.focused, true);
	});

	it("temporarily hides and restores a capturing overlay", () => {
		const tui = new TUI(new VirtualTerminal());
		const base = new OverlayProbe(["base"]);
		const overlay = new OverlayProbe(["modal"]);
		tui.setFocus(base);
		const handle = tui.showOverlay(overlay);

		handle.setHidden(true);
		assert.equal(handle.isHidden(), true);
		assert.equal(base.focused, true);
		handle.setHidden(false);

		assert.equal(handle.isHidden(), false);
		assert.equal(overlay.focused, true);
	});

	it("does not restore focus to a hidden lower overlay", () => {
		const tui = new TUI(new VirtualTerminal());
		const base = new OverlayProbe(["base"]);
		const first = new OverlayProbe(["first"]);
		const second = new OverlayProbe(["second"]);
		tui.setFocus(base);
		const firstHandle = tui.showOverlay(first);
		const secondHandle = tui.showOverlay(second);

		firstHandle.setHidden(true);
		secondHandle.hide();

		assert.equal(base.focused, true);
		assert.equal(first.focused, false);
	});

	it("keeps the current focus for a non-capturing overlay", () => {
		const tui = new TUI(new VirtualTerminal());
		const base = new OverlayProbe(["base"]);
		const overlay = new OverlayProbe(["hint"]);
		tui.setFocus(base);

		const handle = tui.showOverlay(overlay, { nonCapturing: true });

		assert.equal(base.focused, true);
		assert.equal(overlay.focused, false);
		assert.equal(handle.isFocused(), false);
		assert.equal(tui.hasOverlay(), true);
	});

	it("can bring an existing visible overlay to the front and focus it", () => {
		const tui = new TUI(new VirtualTerminal());
		const first = new OverlayProbe(["first"]);
		const second = new OverlayProbe(["second"]);
		const firstHandle = tui.showOverlay(first);
		tui.showOverlay(second);

		firstHandle.focus();

		assert.equal(firstHandle.isFocused(), true);
		assert.equal(first.focused, true);
		assert.equal(tui.render(80).at(-1)?.includes("first"), true);
	});

	it("invalidates overlay components after resize", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const overlay = new OverlayProbe(["modal"]);
		tui.showOverlay(overlay, { width: "50%" });
		tui.start();

		terminal.resize(10, 4);
		await flushRender();

		assert.equal(overlay.invalidateCount, 1);
		assert.equal(overlay.widths.at(-1), 5);
		tui.stop();
	});
});
