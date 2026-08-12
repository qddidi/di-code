import { describe, expect, it, vi } from "vitest";
import { runMain } from "../src/main.ts";

function createIo() {
	return { stdout: vi.fn(), stderr: vi.fn() };
}

describe("runMain", () => {
	it("runs a faux prompt through print mode", async () => {
		const io = createIo();
		const exitCode = await runMain(["--print", "hello"], {
			...io,
			version: "0.0.0",
			fauxResponses: [{ type: "success", content: [{ type: "text", text: "done" }] }],
		});

		expect(exitCode).toBe(0);
		expect(io.stdout).toHaveBeenCalledWith("done\n");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("runs a faux prompt through versioned JSON mode", async () => {
		const io = createIo();
		const exitCode = await runMain(["--mode", "json", "hello"], {
			...io,
			version: "0.0.0",
			fauxResponses: [{ type: "success", content: [{ type: "text", text: "done" }] }],
		});

		expect(exitCode).toBe(0);
		expect(io.stderr).not.toHaveBeenCalled();
		const records = io.stdout.mock.calls.map(
			([line]) => JSON.parse(line.trim()) as { version: number; event: { type: string } },
		);
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((record) => record.version === 1)).toBe(true);
		expect(records.map((record) => record.event.type)).toContain("agent_start");
		expect(records.map((record) => record.event.type)).toContain("agent_end");
	});

	it("preserves help as a no-runtime command", async () => {
		const io = createIo();
		const exitCode = await runMain(["--help"], {
			...io,
			version: "0.0.0",
			fauxResponses: [],
		});

		expect(exitCode).toBe(0);
		expect(io.stdout.mock.calls[0]?.[0]).toContain("Usage: di-code");
		expect(io.stderr).not.toHaveBeenCalled();
	});
});
