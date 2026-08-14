import type { AgentEvent, AgentListener } from "@di-code/agent";
import type { AssistantMessage } from "@di-code/ai";
import { describe, expect, it, vi } from "vitest";
import { type JsonRunner, runJsonMode } from "../src/modes/json.ts";

function assistant(stopReason: "stop" | "error" | "aborted", errorMessage?: string): AssistantMessage {
	if (stopReason === "stop") {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
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
			stopReason,
		};
	}

	return {
		role: "assistant",
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
		timestamp: 1,
		stopReason,
		errorMessage: errorMessage ?? `Request ${stopReason}`,
	};
}

function createRunner(options: { message?: AssistantMessage; reject?: Error; events?: AgentEvent[] }) {
	let listener: AgentListener | undefined;
	const unsubscribe = vi.fn();
	const runner: JsonRunner = {
		subscribe(next) {
			listener = next;
			return unsubscribe;
		},
		async prompt() {
			for (const event of options.events ?? []) {
				await listener?.(event);
			}
			if (options.reject) {
				throw options.reject;
			}
			return options.message ?? assistant("stop");
		},
	};
	return { runner, unsubscribe };
}

function createIo() {
	return { stdout: vi.fn(), stderr: vi.fn() };
}

describe("runJsonMode", () => {
	it("writes versioned JSON records one event per line", async () => {
		const io = createIo();
		const { runner } = createRunner({ events: [{ type: "agent_start" }, { type: "turn_start" }] });

		expect(await runJsonMode("hello", runner, io)).toBe(0);
		const records = io.stdout.mock.calls.map(
			([line]) => JSON.parse(line.trim()) as { version: number; event: AgentEvent },
		);
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.version === 2)).toBe(true);
		expect(records.map((record) => record.event.type)).toEqual(["agent_start", "turn_start"]);
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("keeps failed events on stdout and reports the failure on stderr", async () => {
		const io = createIo();
		const { runner } = createRunner({
			message: assistant("error", "model failed"),
			events: [{ type: "agent_start" }],
		});

		expect(await runJsonMode("fail", runner, io)).toBe(1);
		expect(io.stdout).toHaveBeenCalledTimes(1);
		expect(io.stderr).toHaveBeenCalledWith("model failed\n");
	});

	it("reports rejected prompts and always unsubscribes", async () => {
		const io = createIo();
		const { runner, unsubscribe } = createRunner({ reject: new Error("listener failed") });

		expect(await runJsonMode("reject", runner, io)).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith("listener failed\n");
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
