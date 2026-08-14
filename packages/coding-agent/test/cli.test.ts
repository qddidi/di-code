import { describe, expect, it, vi } from "vitest";
import { parseCliArgs, runCli } from "../src/cli.ts";

describe("parseCliArgs", () => {
	it("parses help and version as static commands", () => {
		expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
	});

	it("defaults a plain prompt to print mode", () => {
		expect(parseCliArgs(["explain", "this"])).toEqual({
			kind: "run",
			mode: "print",
			prompt: "explain this",
		});
	});

	it("parses print aliases and explicit modes", () => {
		expect(parseCliArgs(["-p", "hello"])).toEqual({ kind: "run", mode: "print", prompt: "hello" });
		expect(parseCliArgs(["--print", "hello"])).toEqual({ kind: "run", mode: "print", prompt: "hello" });
		expect(parseCliArgs(["--mode", "json", "hello"])).toEqual({ kind: "run", mode: "json", prompt: "hello" });
	});

	it("parses explicit provider and model options", () => {
		expect(parseCliArgs(["--provider", "anthropic", "--model", "claude-sonnet-4-5", "hello"])).toEqual({
			kind: "run",
			mode: "print",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			prompt: "hello",
		});
	});

	it("parses OpenAI provider options", () => {
		expect(parseCliArgs(["--provider", "openai", "--model", "gpt-4.1-mini", "hello"])).toMatchObject({
			provider: "openai",
			model: "gpt-4.1-mini",
			prompt: "hello",
		});
	});

	it("rejects unsupported providers and missing option values", () => {
		expect(() => parseCliArgs(["--provider", "unknown", "hello"])).toThrow('Unsupported provider "unknown".');
		expect(() => parseCliArgs(["--provider"])).toThrow("Option --provider requires a value.");
		expect(() => parseCliArgs(["--model"])).toThrow("Option --model requires a value.");
	});

	it("rejects missing and unsupported mode values", () => {
		expect(() => parseCliArgs(["--mode"])).toThrow("Option --mode requires a value.");
		expect(() => parseCliArgs(["--mode", "xml", "hello"])).toThrow(
			'Unsupported mode "xml". Expected print, json, or interactive.',
		);
	});

	it("rejects conflicting or unknown options", () => {
		expect(() => parseCliArgs(["--print", "--mode", "json", "hello"])).toThrow(
			"Cannot combine --print with --mode json.",
		);
		expect(() => parseCliArgs(["--wat", "hello"])).toThrow('Unknown option "--wat".');
	});

	it("requires a prompt and keeps static commands exclusive", () => {
		expect(parseCliArgs([])).toEqual({ kind: "run", mode: "interactive", prompt: "" });
		expect(() => parseCliArgs(["--mode", "print"])).toThrow("A prompt is required.");
		expect(() => parseCliArgs(["--help", "hello"])).toThrow("--help must be used on its own.");
		expect(() => parseCliArgs(["--version", "hello"])).toThrow("--version must be used on its own.");
	});
});

describe("runCli", () => {
	it("writes help and version without invoking the run dependency", async () => {
		const stdout = vi.fn<(text: string) => void>();
		const stderr = vi.fn<(text: string) => void>();
		const run = vi.fn(async () => 0);
		const dependencies = { stdout, stderr, run, version: "0.0.0" };

		expect(await runCli(["--help"], dependencies)).toBe(0);
		expect(await runCli(["--version"], dependencies)).toBe(0);
		expect(run).not.toHaveBeenCalled();
		expect(stdout.mock.calls[0]?.[0]).toContain("Usage: di-code");
		expect(stdout.mock.calls[1]?.[0]).toBe("0.0.0\n");
		expect(stderr).not.toHaveBeenCalled();
	});

	it("forwards run commands and reports usage errors on stderr", async () => {
		const stdout = vi.fn<(text: string) => void>();
		const stderr = vi.fn<(text: string) => void>();
		const run = vi.fn(async () => 7);
		const dependencies = { stdout, stderr, run, version: "0.0.0" };

		expect(await runCli(["--mode", "json", "hello"], dependencies)).toBe(7);
		expect(run).toHaveBeenCalledWith({ kind: "run", mode: "json", prompt: "hello" });
		expect(await runCli(["--wat"], dependencies)).toBe(1);
		expect(stderr).toHaveBeenCalledWith('Unknown option "--wat".\n');
		expect(stdout).not.toHaveBeenCalled();
	});
});
