import type { AssistantMessage, FailedAssistantMessage, SuccessfulAssistantMessage } from "@di-code/ai";
import { describe, expect, it, vi } from "vitest";
import { type PrintIo, type PromptRunner, runPrintMode } from "../src/modes/print.ts";

function successfulMessage(content: SuccessfulAssistantMessage["content"]): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content,
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
		timestamp: 100,
		stopReason: "stop",
	};
}

function failedMessage(stopReason: "error" | "aborted", errorMessage: string): FailedAssistantMessage {
	return {
		...successfulMessage([]),
		stopReason,
		errorMessage,
	};
}

function createIo(): PrintIo {
	return { stdout: vi.fn(), stderr: vi.fn() };
}

function createRunner(message: AssistantMessage): PromptRunner {
	return { prompt: vi.fn(async () => message) };
}

describe("runPrintMode", () => {
	it("writes only ordered text blocks and returns zero", async () => {
		const io = createIo();
		const runner = createRunner(
			successfulMessage([
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
			]),
		);

		expect(await runPrintMode("say hello", runner, io)).toBe(0);
		expect(runner.prompt).toHaveBeenCalledWith("say hello");
		expect(io.stdout).toHaveBeenCalledWith("hello world\n");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("writes assistant failures only to stderr", async () => {
		const io = createIo();
		const runner = createRunner(failedMessage("error", "model failed"));

		expect(await runPrintMode("fail", runner, io)).toBe(1);
		expect(io.stdout).not.toHaveBeenCalled();
		expect(io.stderr).toHaveBeenCalledWith("model failed\n");
	});

	it("uses a stable cancellation diagnostic", async () => {
		const io = createIo();
		const runner = createRunner(failedMessage("aborted", "request cancelled"));

		expect(await runPrintMode("cancel", runner, io)).toBe(1);
		expect(io.stdout).not.toHaveBeenCalled();
		expect(io.stderr).toHaveBeenCalledWith("request cancelled\n");
	});

	it("converts a rejected prompt into a stderr diagnostic", async () => {
		const io = createIo();
		const runner: PromptRunner = {
			prompt: vi.fn(async () => {
				throw new Error("listener failed");
			}),
		};

		expect(await runPrintMode("reject", runner, io)).toBe(1);
		expect(io.stdout).not.toHaveBeenCalled();
		expect(io.stderr).toHaveBeenCalledWith("listener failed\n");
	});
});
