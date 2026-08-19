import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@di-code/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runProviderOnboarding,
	type StartupRunCommand,
	shouldStartProviderOnboarding,
} from "../src/provider-onboarding.ts";
import { loadStartupConfiguration, resolveStartupRuntime, type StartupConfiguration } from "../src/startup.ts";

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

	it("does not replace explicit, default, or single-provider selection", () => {
		expect(
			shouldStartProviderOnboarding(command("interactive"), true, configuration({ DI_CODE_PROVIDER: "faux" })),
		).toBe(false);
		expect(
			shouldStartProviderOnboarding(command("interactive"), true, {
				environment: {},
				providers: [{ id: "custom", api: "openai-responses", models: [] }],
			}),
		).toBe(false);
		expect(
			shouldStartProviderOnboarding(command("interactive"), true, {
				environment: {},
				providers: [
					{ id: "openai", api: "openai-responses" },
					{ id: "zhipu", api: "openai-chat-completions" },
				],
				defaults: { providerId: "zhipu" },
			}),
		).toBe(false);
	});

	it("starts the chooser when several Providers have no selected default", () => {
		expect(
			shouldStartProviderOnboarding(command("interactive"), true, {
				environment: {},
				providers: [
					{ id: "openai", api: "openai-responses" },
					{ id: "zhipu", api: "openai-chat-completions" },
				],
			}),
		).toBe(true);
	});
});

describe("runProviderOnboarding", () => {
	let root: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-provider-onboarding-"));
		agentDir = join(root, "agent");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("selects DeepSeek and keeps the entered API key out of terminal output", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration(),
			terminal,
			agentDir,
		});

		terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");
		terminal.send("test-deepseek-secret");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("deepseek");
		expect(runtime?.model.id).toBe("deepseek-v4-flash");
		expect(terminal.output).toContain("╭");
		expect(terminal.output).toContain("╰");
		expect(terminal.output).not.toContain("test-deepseek-secret");
		expect(terminal.started).toBe(false);
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-flash",
			providers: {
				deepseek: {
					api: "openai-chat-completions",
					apiKey: "test-deepseek-secret",
				},
			},
		});
		const persisted = await loadStartupConfiguration(root, {}, agentDir);
		expect(resolveStartupRuntime(persisted.environment, persisted.providers, persisted.defaults).provider.id).toBe(
			"deepseek",
		);
	});

	it("uses an existing OpenAI key without opening the credential step", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration({ OPENAI_API_KEY: "existing-test-key" }),
			terminal,
			agentDir,
		});

		terminal.send("\r");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("openai");
		expect(runtime?.model.id).toBe("gpt-4o");
		expect(terminal.output).not.toContain("existing-test-key");
		await expect(access(join(agentDir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("selects Faux without asking for an API key", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration(),
			terminal,
			agentDir,
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
		const result = runProviderOnboarding({ configuration: configuration(), terminal, agentDir });

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

	it("selects Anthropic and keeps the entered API key out of terminal output", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({ configuration: configuration(), terminal, agentDir });

		terminal.send("\x1b[B");
		terminal.send("\x1b[B");
		terminal.send("\x1b[B");
		terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");
		terminal.send("test-anthropic-secret");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("anthropic");
		expect(runtime?.model.id).toBe("claude-sonnet-4-5");
		expect(terminal.output).not.toContain("test-anthropic-secret");
	});

	it("selects Kimi and persists its hidden API key", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({ configuration: configuration(), terminal, agentDir });

		for (let index = 0; index < 6; index += 1) terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");
		terminal.send("test-kimi-secret");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("kimi");
		expect(runtime?.model.id).toBe("k3");
		expect(terminal.output).not.toContain("test-kimi-secret");
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: "kimi",
			defaultModel: "k3",
			providers: { kimi: { api: "openai-chat-completions", apiKey: "test-kimi-secret" } },
		});
	});

	it("configures a Custom gateway without exposing its API key", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({ configuration: configuration(), terminal, agentDir });

		for (let index = 0; index < 5; index += 1) terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("https://gateway.example.test/v1");
		terminal.send("\r");
		terminal.send("custom-gateway-secret");
		terminal.send("\r");
		terminal.send("gpt-4o");
		terminal.send("\r");

		const runtime = await result;
		expect(runtime?.provider.id).toBe("custom");
		expect(runtime?.model).toMatchObject({ id: "gpt-4o", provider: "custom", input: ["text"] });
		expect(terminal.output).not.toContain("custom-gateway-secret");
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: "custom",
			defaultModel: "gpt-4o",
			providers: { custom: { apiKey: "custom-gateway-secret", baseUrl: "https://gateway.example.test/v1" } },
		});
	});

	it("keeps Custom base URL input active after validation fails and cancels without persisting", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({ configuration: configuration(), terminal, agentDir });

		for (let index = 0; index < 5; index += 1) terminal.send("\x1b[B");
		terminal.send("\r");
		terminal.send("\r");
		terminal.send("https://gateway.example.test/v1/");
		terminal.send("\r");
		terminal.send("\x03");

		await expect(result).resolves.toBeUndefined();
		await expect(access(join(agentDir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects an empty key and lets Ctrl-C cancel without creating a runtime", async () => {
		const terminal = new TestTerminal();
		const result = runProviderOnboarding({
			configuration: configuration(),
			terminal,
			agentDir,
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
		const result = runProviderOnboarding({ configuration: configuration(), terminal, agentDir });

		terminal.send("\x04");

		await expect(result).resolves.toBeUndefined();
		expect(terminal.started).toBe(false);
	});
});
