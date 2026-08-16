import type { Terminal } from "@di-code/tui";
import { describe, expect, it } from "vitest";
import {
	runProviderOnboarding,
	type StartupRunCommand,
	shouldStartProviderOnboarding,
} from "../src/provider-onboarding.ts";
import type { StartupConfiguration } from "../src/startup.ts";

class TestTerminal implements Terminal {
	readonly columns = 80;
	readonly rows = 24;
	private input?: (data: string) => void;
	private writes: string[] = [];
	started = false;

	start(onInput: (data: string) => void): void {
		this.started = true;
		this.input = onInput;
	}

	stop(): void {
		this.started = false;
		this.input = undefined;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	moveBy(lines: number): void {
		this.write(`move:${lines}`);
	}

	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}

	send(data: string): void {
		this.input?.(data);
	}

	get output(): string {
		return this.writes.join("");
	}
}

function command(mode: StartupRunCommand["mode"]): StartupRunCommand {
	return { kind: "run", mode, prompt: "" };
}

function configuration(environment: StartupConfiguration["environment"] = {}): StartupConfiguration {
	return { environment, providers: [] };
}

describe("shouldStartProviderOnboarding", () => {
	it("starts only for an unconfigured interactive TTY", () => {
		expect(shouldStartProviderOnboarding(command("interactive"), true, configuration())).toBe(true);
		expect(shouldStartProviderOnboarding(command("interactive"), false, configuration())).toBe(false);
		expect(shouldStartProviderOnboarding(command("print"), true, configuration())).toBe(false);
		expect(shouldStartProviderOnboarding(command("json"), true, configuration())).toBe(false);
	});

	it("does not replace explicit or settings-based provider selection", () => {
		expect(
			shouldStartProviderOnboarding(command("interactive"), true, configuration({ DI_CODE_PROVIDER: "faux" })),
		).toBe(false);
		expect(
			shouldStartProviderOnboarding(command("interactive"), true, {
				environment: {},
				providers: [{ id: "custom", api: "openai-responses", models: [] }],
			}),
		).toBe(false);
	});
});

describe("runProviderOnboarding", () => {
	it("selects DeepSeek and keeps the entered API key out of terminal output", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration(),
			terminal,
		});

		terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");
		terminal.send("test-deepseek-secret");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("deepseek");
		expect(runtime?.model.id).toBe("deepseek-v4-flash");
		expect(terminal.output).not.toContain("test-deepseek-secret");
		expect(terminal.started).toBe(false);
	});

	it("uses an existing OpenAI key without opening the credential step", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration({ OPENAI_API_KEY: "existing-test-key" }),
			terminal,
		});

		terminal.send("\r");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("openai");
		expect(runtime?.model.id).toBe("gpt-4o");
		expect(terminal.output).not.toContain("existing-test-key");
	});

	it("selects Faux without asking for an API key", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration(),
			terminal,
		});

		terminal.send("\x1b[B");
		terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("faux");
		expect(runtime?.model.id).toBe("faux-model");
	});

	it("selects Zhipu and keeps the entered API key out of terminal output", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({ configuration: configuration(), terminal });

		terminal.send("\x1b[B");
		terminal.send("\x1b[B");
		terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");
		terminal.send("test-zhipu-secret");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("zhipu");
		expect(runtime?.model.id).toBe("glm-5.3");
		expect(terminal.output).not.toContain("test-zhipu-secret");
	});

	it("rejects an empty key and lets Ctrl-C cancel without creating a runtime", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration(),
			terminal,
		});

		terminal.send("\r");
		terminal.send("\r");
		terminal.send("   ");
		terminal.send("\r");
		terminal.send("\x03");

		await expect(result).resolves.toBeUndefined();
		expect(terminal.started).toBe(false);
	});

	it("treats Ctrl-D as cancellation while choosing a provider", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({ configuration: configuration(), terminal });

		terminal.send("\x04");

		await expect(result).resolves.toBeUndefined();
		expect(terminal.started).toBe(false);
	});
});
