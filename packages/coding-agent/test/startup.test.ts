import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStartupConfiguration, resolveStartupArgs, resolveStartupRuntime } from "../src/startup.ts";

describe("resolveStartupArgs", () => {
	it("starts interactive mode when the process receives no arguments", () => {
		expect(resolveStartupArgs([])).toEqual(["--interactive"]);
	});

	it("preserves explicit CLI arguments", () => {
		expect(resolveStartupArgs(["--help"])).toEqual(["--help"]);
		expect(resolveStartupArgs(["--mode", "json", "hello"])).toEqual(["--mode", "json", "hello"]);
	});
});

describe("Pi-style startup configuration", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-settings-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function writeSettings(value: unknown): Promise<void> {
		await mkdir(join(root, ".di-code"), { recursive: true });
		await writeFile(join(root, ".di-code", "settings.json"), JSON.stringify(value));
	}

	it("loads providers, inherits provider fields, and applies Pi model defaults", async () => {
		await writeSettings({
			providers: {
				amux: {
					name: "AMUX",
					baseUrl: "https://api.example.test/v1",
					api: "openai-responses",
					apiKey: "$AMUX_API_KEY",
					models: [{ id: "gpt-custom" }],
				},
			},
		});

		const configuration = await loadStartupConfiguration(root, { AMUX_API_KEY: "test-key" });

		expect(configuration.providers).toHaveLength(1);
		expect(configuration.providers[0]).toMatchObject({
			id: "amux",
			name: "AMUX",
			api: "openai-responses",
			apiKey: "$AMUX_API_KEY",
			baseUrl: "https://api.example.test/v1",
			models: [
				{
					id: "gpt-custom",
					name: "gpt-custom",
					provider: "amux",
					api: "openai-responses",
					baseUrl: "https://api.example.test/v1",
					input: ["text"],
					reasoning: false,
					contextWindow: 128000,
					maxOutputTokens: 16384,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
	});

	it("maps maxTokens and per-million prices into the internal model contract", async () => {
		await writeSettings({
			providers: {
				amux: {
					baseUrl: "https://api.example.test/v1",
					api: "openai-responses",
					models: [
						{
							id: "gpt-custom",
							input: ["text", "image"],
							reasoning: true,
							contextWindow: 256000,
							maxTokens: 32000,
							cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
						},
					],
				},
			},
		});

		const configuration = await loadStartupConfiguration(root, {});

		expect(configuration.providers[0]?.models?.[0]).toMatchObject({
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 256000,
			maxOutputTokens: 32000,
			cost: { input: 0.0000025, output: 0.00001, cacheRead: 0.00000125, cacheWrite: 0 },
		});
	});

	it("keeps a model endpoint override over the provider endpoint", async () => {
		await writeSettings({
			providers: {
				amux: {
					baseUrl: "https://provider.example.test/v1",
					api: "openai-responses",
					apiKey: "$AMUX_API_KEY",
					models: [{ id: "gpt-custom", baseUrl: "https://model.example.test/v1" }],
				},
			},
		});

		const configuration = await loadStartupConfiguration(root, { AMUX_API_KEY: "test-key" });
		const runtime = resolveStartupRuntime(configuration.environment, configuration.providers);

		expect(runtime.model.baseUrl).toBe("https://model.example.test/v1");
	});

	it("rejects the removed legacy settings shape", async () => {
		await writeSettings({ provider: "openai", openai: { model: "gpt-4o" } });

		await expect(loadStartupConfiguration(root, {})).rejects.toThrow(
			".di-code\\settings.json: providers must be an object",
		);
	});

	it("reports invalid settings files", async () => {
		await mkdir(join(root, ".di-code"));
		await writeFile(join(root, ".di-code", "settings.json"), "{");

		await expect(loadStartupConfiguration(root, {})).rejects.toThrow(".di-code\\settings.json: invalid JSON");
	});

	it("returns no configured providers when the file does not exist", async () => {
		await expect(loadStartupConfiguration(root, { DI_CODE_PROVIDER: "faux" })).resolves.toEqual({
			environment: { DI_CODE_PROVIDER: "faux" },
			providers: [],
		});
	});

	it("treats an empty or whitespace-only settings file as unconfigured", async () => {
		await mkdir(join(root, ".di-code"));
		await writeFile(join(root, ".di-code", "settings.json"), " \r\n\t");

		await expect(loadStartupConfiguration(root, {})).resolves.toEqual({ environment: {}, providers: [] });
	});
});

describe("resolveStartupRuntime", () => {
	const amux = {
		id: "amux",
		name: "AMUX",
		api: "openai-responses",
		apiKey: "$AMUX_API_KEY",
		baseUrl: "https://api.example.test/v1",
		models: [
			{
				id: "gpt-a",
				name: "GPT A",
				provider: "amux",
				api: "openai-responses",
				baseUrl: "https://api.example.test/v1",
				input: ["text" as const],
				reasoning: false,
				contextWindow: 128000,
				maxOutputTokens: 16384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};

	it("selects the only provider and its first model", () => {
		const runtime = resolveStartupRuntime({ AMUX_API_KEY: "test-key" }, [amux]);

		expect(runtime.provider).toMatchObject({ id: "amux", name: "AMUX" });
		expect(runtime.model).toMatchObject({ id: "gpt-a", provider: "amux" });
	});

	it("selects an explicit provider and model", () => {
		const other = { ...amux, id: "other", models: amux.models.map((model) => ({ ...model, provider: "other" })) };
		const runtime = resolveStartupRuntime(
			{ DI_CODE_PROVIDER: "other", DI_CODE_MODEL: "gpt-a", AMUX_API_KEY: "test-key" },
			[amux, other],
		);

		expect(runtime.provider.id).toBe("other");
		expect(runtime.model.id).toBe("gpt-a");
	});

	it("requires a configured API key environment variable without exposing a value", () => {
		expect(() => resolveStartupRuntime({}, [amux])).toThrow(
			'Configured apiKey environment variable "AMUX_API_KEY" is not set.',
		);
	});

	it("rejects unsupported APIs", () => {
		expect(() => resolveStartupRuntime({ AMUX_API_KEY: "test-key" }, [{ ...amux, api: "openai-completions" }])).toThrow(
			'Unsupported API "openai-completions" for provider "amux". Expected openai-responses, deepseek-responses, zhipu-chat-completions, or anthropic-messages.',
		);
	});

	it("requires a provider choice when several are configured", () => {
		const other = { ...amux, id: "other", models: amux.models.map((model) => ({ ...model, provider: "other" })) };
		expect(() => resolveStartupRuntime({ AMUX_API_KEY: "test-key" }, [amux, other])).toThrow(
			"DI_CODE_PROVIDER is required when more than one provider is configured.",
		);
	});

	it("explains how to start when no provider is configured", () => {
		expect(() => resolveStartupRuntime({}, [])).toThrow(
			"Provider is not configured. Set DI_CODE_PROVIDER or start interactive mode in a TTY.",
		);
	});

	it("rejects a provider outside the configured set", () => {
		expect(() => resolveStartupRuntime({ DI_CODE_PROVIDER: "missing", AMUX_API_KEY: "test-key" }, [amux])).toThrow(
			'Unknown configured provider "missing". Available providers: amux.',
		);
	});

	it("uses the deterministic Faux provider when explicitly selected", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "faux" }, []);

		expect(runtime.provider.id).toBe("faux");
		expect(runtime.model).toEqual(runtime.provider.models[0]);
	});

	it("uses the built-in OpenAI provider without settings models", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }, []);

		expect(runtime.provider).toMatchObject({ id: "openai", name: "OpenAI" });
		expect(runtime.model).toMatchObject({ id: "gpt-4o", provider: "openai", api: "openai-responses" });
	});

	it("uses the built-in Anthropic provider from environment configuration", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" }, []);

		expect(runtime.provider).toMatchObject({ id: "anthropic", name: "Anthropic" });
		expect(runtime.model).toMatchObject({
			id: "claude-sonnet-4-5",
			provider: "anthropic",
			api: "anthropic-messages",
		});
	});

	it("uses the built-in DeepSeek provider from environment configuration", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test-key" }, []);

		expect(runtime.provider).toMatchObject({ id: "deepseek", name: "DeepSeek" });
		expect(runtime.model).toMatchObject({
			id: "deepseek-v4-flash",
			provider: "deepseek",
			api: "deepseek-responses",
		});
	});

	it("uses the built-in Zhipu provider from environment configuration", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "zhipu", ZAI_API_KEY: "test-key" }, []);

		expect(runtime.provider).toMatchObject({ id: "zhipu", name: "Zhipu AI" });
		expect(runtime.model).toMatchObject({
			id: "glm-5.3",
			provider: "zhipu",
			api: "zhipu-chat-completions",
		});
	});

	it("selects an explicit built-in DeepSeek model", () => {
		const runtime = resolveStartupRuntime(
			{
				DI_CODE_PROVIDER: "deepseek",
				DI_CODE_MODEL: "deepseek-v4-pro",
				DEEPSEEK_API_KEY: "test-key",
			},
			[],
		);

		expect(runtime.model).toMatchObject({ id: "deepseek-v4-pro", provider: "deepseek" });
	});

	it("allows a configured DeepSeek provider to use generated models", () => {
		const runtime = resolveStartupRuntime({ DEEPSEEK_API_KEY: "test-key" }, [
			{ id: "deepseek", api: "deepseek-responses" },
		]);

		expect(runtime.provider.id).toBe("deepseek");
		expect(runtime.model).toMatchObject({ id: "deepseek-v4-flash", api: "deepseek-responses" });
	});

	it("allows a configured Zhipu provider to use the generated Coding Plan models", () => {
		const runtime = resolveStartupRuntime({ ZAI_API_KEY: "test-key" }, [
			{ id: "zhipu", api: "zhipu-chat-completions" },
		]);

		expect(runtime.provider.id).toBe("zhipu");
		expect(runtime.model).toMatchObject({ id: "glm-5.3", api: "zhipu-chat-completions" });
	});
});
