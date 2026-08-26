import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadStartupConfiguration,
	removeGlobalProviderApiKey,
	resolveStartupArgs,
	resolveStartupRuntime,
	resolveThinkingLevelPreference,
	saveGlobalCustomProvider,
	saveGlobalLocale,
	saveGlobalModelSelection,
	saveGlobalThinkingLevel,
	saveScopedModelSelection,
	saveScopedThinkingLevel,
	validateCustomBaseUrl,
} from "../src/startup.ts";

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
	let globalDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-settings-"));
		globalDir = join(root, "global");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function writeSettings(value: unknown): Promise<void> {
		await mkdir(join(root, ".di-code"), { recursive: true });
		await writeFile(join(root, ".di-code", "settings.json"), JSON.stringify(value));
	}

	async function writeGlobalSettings(value: unknown): Promise<void> {
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "settings.json"), JSON.stringify(value));
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

		const configuration = await loadStartupConfiguration(root, { AMUX_API_KEY: "test-key" }, globalDir);

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

	it("rejects a configured model that leaves no context for input", async () => {
		await writeSettings({
			providers: {
				gateway: {
					api: "openai-responses",
					baseUrl: "https://api.example.test/v1",
					models: [{ id: "gateway-model", contextWindow: 8_192, maxTokens: 8_192 }],
				},
			},
		});

		await expect(loadStartupConfiguration(root, {}, globalDir)).rejects.toThrow(
			"models[0].maxTokens must be smaller than contextWindow",
		);
	});

	it("saves a Custom provider with known model capabilities and preserves unrelated global settings", async () => {
		await writeGlobalSettings({
			locale: "zh-CN",
			providers: { other: { api: "openai-responses", apiKey: "other-key", models: [{ id: "other-model" }] } },
		});

		await saveGlobalCustomProvider(globalDir, {
			api: "openai-responses",
			baseUrl: "https://gateway.example.test/v1",
			apiKey: "custom-secret",
			modelId: "gpt-4o",
		});

		const saved = JSON.parse(await readFile(join(globalDir, "settings.json"), "utf8"));
		expect(saved).toMatchObject({
			locale: "zh-CN",
			defaultProvider: "custom",
			defaultModel: "gpt-4o",
			providers: {
				other: { apiKey: "other-key" },
				custom: {
					api: "openai-responses",
					baseUrl: "https://gateway.example.test/v1",
					apiKey: "custom-secret",
					models: [{ id: "gpt-4o", input: ["text", "image"], contextWindow: 128000 }],
				},
			},
		});
		const restored = await loadStartupConfiguration(root, {}, globalDir);
		const runtime = resolveStartupRuntime(restored.environment, restored.providers, restored.defaults);
		expect(runtime.model).toMatchObject({
			id: "gpt-4o",
			provider: "custom",
			baseUrl: "https://gateway.example.test/v1",
		});
	});

	it("uses conservative defaults for a Custom model not in the selected protocol catalog", async () => {
		const custom = await saveGlobalCustomProvider(globalDir, {
			api: "openai-chat-completions",
			baseUrl: "https://gateway.example.test/v1",
			apiKey: "custom-secret",
			modelId: "gpt-4o",
		});

		expect(custom.models?.[0]).toEqual({
			id: "gpt-4o",
			name: "gpt-4o",
			provider: "custom",
			api: "openai-chat-completions",
			baseUrl: "https://gateway.example.test/v1",
			input: ["text"],
			reasoning: false,
			contextWindow: 128000,
			maxOutputTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("rejects unsafe Custom endpoints before writing settings", () => {
		expect(() => validateCustomBaseUrl("https://gateway.example.test/v1/")).toThrow("must not end with /");
		expect(() => validateCustomBaseUrl("https://user:secret@gateway.example.test/v1")).toThrow(
			"must not contain credentials",
		);
		expect(() => validateCustomBaseUrl("file:///tmp/gateway")).toThrow("must use http or https");
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
							cacheRetention: "long",
							sessionAffinity: "codex",
							contextWindow: 256000,
							maxTokens: 32000,
							cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
						},
					],
				},
			},
		});

		const configuration = await loadStartupConfiguration(root, {}, globalDir);

		expect(configuration.providers[0]?.models?.[0]).toMatchObject({
			input: ["text", "image"],
			reasoning: true,
			reasoningEfforts: ["low", "medium", "high"],
			cacheRetention: "long",
			sessionAffinity: "codex",
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

		const configuration = await loadStartupConfiguration(root, { AMUX_API_KEY: "test-key" }, globalDir);
		const runtime = resolveStartupRuntime(configuration.environment, configuration.providers);

		expect(runtime.model.baseUrl).toBe("https://model.example.test/v1");
	});

	it("rejects the removed legacy settings shape", async () => {
		await writeSettings({ provider: "openai", openai: { model: "gpt-4o" } });

		await expect(loadStartupConfiguration(root, {}, globalDir)).rejects.toThrow(
			".di-code\\settings.json: providers must be an object",
		);
	});

	it("reports invalid settings files", async () => {
		await mkdir(join(root, ".di-code"));
		await writeFile(join(root, ".di-code", "settings.json"), "{");

		await expect(loadStartupConfiguration(root, {}, globalDir)).rejects.toThrow(
			".di-code\\settings.json: invalid JSON",
		);
	});

	it("returns no configured providers when the file does not exist", async () => {
		await expect(loadStartupConfiguration(root, { DI_CODE_PROVIDER: "faux" }, globalDir)).resolves.toEqual({
			environment: { DI_CODE_PROVIDER: "faux" },
			providers: [],
		});
	});

	it("treats an empty or whitespace-only settings file as unconfigured", async () => {
		await mkdir(join(root, ".di-code"));
		await writeFile(join(root, ".di-code", "settings.json"), " \r\n\t");

		await expect(loadStartupConfiguration(root, {}, globalDir)).resolves.toEqual({ environment: {}, providers: [] });
	});

	it("uses the global locale and lets DI_CODE_LOCALE override it", async () => {
		await writeGlobalSettings({ locale: "zh-CN", providers: {} });

		expect((await loadStartupConfiguration(root, {}, globalDir)).locale).toBe("zh-CN");
		expect((await loadStartupConfiguration(root, { DI_CODE_LOCALE: "en" }, globalDir)).locale).toBe("en");
		await expect(loadStartupConfiguration(root, { DI_CODE_LOCALE: "fr" }, globalDir)).rejects.toThrow(
			'DI_CODE_LOCALE must be "en" or "zh-CN".',
		);
	});

	it("persists a global locale without removing Provider settings", async () => {
		await writeGlobalSettings({ locale: "en", providers: { faux: { api: "faux", models: [{ id: "faux-model" }] } } });

		await saveGlobalLocale(globalDir, "zh-CN");

		expect(JSON.parse(await readFile(join(globalDir, "settings.json"), "utf8"))).toMatchObject({
			locale: "zh-CN",
			providers: { faux: { api: "faux", models: [{ id: "faux-model" }] } },
		});
	});

	it("persists an interactive model selection as the next startup default", async () => {
		await writeGlobalSettings({ locale: "zh-CN", providers: {} });

		await saveGlobalModelSelection(globalDir, "zhipu", "glm-5.2");

		expect(JSON.parse(await readFile(join(globalDir, "settings.json"), "utf8"))).toMatchObject({
			locale: "zh-CN",
			defaultProvider: "zhipu",
			defaultModel: "glm-5.2",
		});
		const configuration = await loadStartupConfiguration(root, { ZAI_API_KEY: "test-key" }, globalDir);
		expect(
			resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults).model.id,
		).toBe("glm-5.2");
	});

	it("merges project thinking preferences over global preferences", async () => {
		await writeGlobalSettings({ providers: {}, thinkingLevels: { zhipu: { "glm-5.3": "max" } } });
		await writeSettings({ providers: {}, thinkingLevels: { zhipu: { "glm-5.3": "low" } } });

		await saveGlobalThinkingLevel(globalDir, "zhipu", "glm-5.2", "high");

		expect(JSON.parse(await readFile(join(globalDir, "settings.json"), "utf8"))).toMatchObject({
			thinkingLevels: { zhipu: { "glm-5.3": "max", "glm-5.2": "high" } },
		});
		expect((await loadStartupConfiguration(root, {}, globalDir)).thinkingLevels).toEqual({
			zhipu: { "glm-5.3": "low", "glm-5.2": "high" },
		});
	});

	it("persists model and thinking preferences in existing workspace settings", async () => {
		await writeGlobalSettings({ providers: {}, defaultProvider: "zhipu", defaultModel: "glm-5.3" });
		await writeSettings({ providers: {}, defaultProvider: "zhipu", defaultModel: "glm-5.3" });

		await saveScopedModelSelection(root, globalDir, "zhipu", "glm-5.2");
		await saveScopedThinkingLevel(root, globalDir, "zhipu", "glm-5.2", "high");

		expect(JSON.parse(await readFile(join(root, ".di-code", "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: "zhipu",
			defaultModel: "glm-5.2",
			thinkingLevels: { zhipu: { "glm-5.2": "high" } },
		});
		expect(JSON.parse(await readFile(join(globalDir, "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: "zhipu",
			defaultModel: "glm-5.3",
		});
	});

	it("lets Web and TUI read each other's global defaults from the same agent directory", async () => {
		await writeGlobalSettings({
			providers: { zhipu: { api: "openai-chat-completions", apiKey: "$ZAI_API_KEY" } },
		});

		// The TUI writer updates the product-level root. A Web startup resolver sees it unchanged.
		await saveGlobalModelSelection(globalDir, "zhipu", "glm-5.2");
		await saveGlobalThinkingLevel(globalDir, "zhipu", "glm-5.2", "high");
		const webRead = await loadStartupConfiguration(root, { ZAI_API_KEY: "test-key" }, globalDir);
		expect(webRead.defaults).toEqual({ providerId: "zhipu", modelId: "glm-5.2" });
		expect(webRead.thinkingLevels).toEqual({ zhipu: { "glm-5.2": "high" } });

		// Web uses the same writer and root, so a fresh TUI resolver observes the replacement default.
		await saveGlobalModelSelection(globalDir, "zhipu", "glm-5.3");
		const tuiRead = await loadStartupConfiguration(root, { ZAI_API_KEY: "test-key" }, globalDir);
		expect(tuiRead.defaults).toEqual({ providerId: "zhipu", modelId: "glm-5.3" });
		expect(tuiRead.thinkingLevels).toEqual({ zhipu: { "glm-5.2": "high" } });
	});

	it("restores a thinking preference only when the selected model still supports it", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "zhipu", ZAI_API_KEY: "test-key" }, []);

		expect(
			resolveThinkingLevelPreference(
				{ environment: {}, providers: [], thinkingLevels: { zhipu: { "glm-5.3": "low" } } },
				runtime,
			),
		).toBe("low");
		expect(
			resolveThinkingLevelPreference(
				{ environment: {}, providers: [], thinkingLevels: { zhipu: { "glm-5.3": "medium" } } },
				runtime,
			),
		).toBeUndefined();
	});

	it("loads providers from the user settings file when the project has no settings", async () => {
		await writeGlobalSettings({
			providers: {
				global: {
					api: "openai-responses",
					baseUrl: "https://global.example.test/v1",
					apiKey: "$GLOBAL_API_KEY",
					models: [{ id: "global-model" }],
				},
			},
		});

		const configuration = await loadStartupConfiguration(root, { GLOBAL_API_KEY: "global-key" }, globalDir);

		expect(configuration.providers).toHaveLength(1);
		expect(configuration.providers[0]).toMatchObject({
			id: "global",
			api: "openai-responses",
			baseUrl: "https://global.example.test/v1",
			apiKey: "$GLOBAL_API_KEY",
		});
	});

	it("merges project provider fields over global provider fields", async () => {
		await writeGlobalSettings({
			providers: {
				shared: {
					api: "openai-responses",
					baseUrl: "https://global.example.test/v1",
					apiKey: "$GLOBAL_API_KEY",
					models: [{ id: "global-model" }],
				},
			},
		});
		await writeSettings({
			providers: {
				shared: { baseUrl: "https://project.example.test/v1" },
				projectOnly: {
					api: "openai-responses",
					models: [{ id: "project-model" }],
				},
			},
		});

		const configuration = await loadStartupConfiguration(root, {}, globalDir);

		expect(configuration.providers).toHaveLength(2);
		expect(configuration.providers[0]).toMatchObject({
			id: "shared",
			baseUrl: "https://project.example.test/v1",
			apiKey: "$GLOBAL_API_KEY",
			models: [{ id: "global-model" }],
		});
		expect(configuration.providers[1]?.id).toBe("projectOnly");
	});

	it("uses the saved global Provider and model defaults when more than one Provider is configured", async () => {
		await writeGlobalSettings({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-pro",
			providers: {
				deepseek: { api: "openai-chat-completions", apiKey: "$DEEPSEEK_API_KEY" },
				openai: { api: "openai-responses", apiKey: "$OPENAI_API_KEY" },
			},
		});

		const configuration = await loadStartupConfiguration(
			root,
			{
				DEEPSEEK_API_KEY: "deepseek-test-key",
				OPENAI_API_KEY: "openai-test-key",
			},
			globalDir,
		);
		const runtime = resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);

		expect(configuration.defaults).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-pro" });
		expect(runtime.provider.id).toBe("deepseek");
		expect(runtime.model.id).toBe("deepseek-v4-pro");
	});

	it("lets explicit Provider and model environment variables override saved defaults", async () => {
		const runtime = resolveStartupRuntime(
			{
				DI_CODE_PROVIDER: "openai",
				DI_CODE_MODEL: "gpt-4o",
				DEEPSEEK_API_KEY: "deepseek-test-key",
				OPENAI_API_KEY: "openai-test-key",
			},
			[
				{ id: "deepseek", api: "openai-chat-completions", apiKey: "$DEEPSEEK_API_KEY" },
				{ id: "openai", api: "openai-responses", apiKey: "$OPENAI_API_KEY" },
			],
			{ providerId: "deepseek", modelId: "deepseek-v4-pro" },
		);

		expect(runtime.provider.id).toBe("openai");
		expect(runtime.model.id).toBe("gpt-4o");
	});

	it("removes one global provider API key, clears its default, and preserves remaining configuration", async () => {
		await writeGlobalSettings({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-model",
			providers: {
				deepseek: {
					api: "openai-chat-completions",
					apiKey: "stored-test-key",
					baseUrl: "https://api.deepseek.example.test/v1",
					models: [{ id: "deepseek-model" }],
				},
				other: { api: "openai-responses", apiKey: "other-test-key", models: [{ id: "other-model" }] },
			},
		});

		expect(await removeGlobalProviderApiKey(globalDir, "deepseek")).toBe(true);
		expect(JSON.parse(await readFile(join(globalDir, "settings.json"), "utf8"))).toEqual({
			providers: {
				deepseek: {
					api: "openai-chat-completions",
					baseUrl: "https://api.deepseek.example.test/v1",
					models: [{ id: "deepseek-model" }],
				},
				other: { api: "openai-responses", apiKey: "other-test-key", models: [{ id: "other-model" }] },
			},
		});
	});

	it("does not create or rewrite settings when the global provider has no API key", async () => {
		await writeGlobalSettings({ providers: { deepseek: { api: "openai-chat-completions" } } });
		const settingsPath = join(globalDir, "settings.json");
		const before = await readFile(settingsPath, "utf8");

		expect(await removeGlobalProviderApiKey(globalDir, "deepseek")).toBe(false);
		expect(await readFile(settingsPath, "utf8")).toBe(before);
		expect(await removeGlobalProviderApiKey(join(root, "missing"), "deepseek")).toBe(false);
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

	it("creates a custom OpenAI Chat Completions provider", () => {
		const runtime = resolveStartupRuntime({ CUSTOM_CHAT_API_KEY: "test-key", DI_CODE_PROVIDER: "custom-chat" }, [
			{
				id: "custom-chat",
				name: "Custom Chat",
				api: "openai-chat-completions",
				apiKey: "$CUSTOM_CHAT_API_KEY",
				baseUrl: "https://chat.example.test/v1",
				models: [
					{
						id: "custom-model",
						name: "Custom Model",
						provider: "custom-chat",
						api: "openai-chat-completions",
						baseUrl: "https://chat.example.test/v1",
						input: ["text"],
						reasoning: false,
						contextWindow: 128000,
						maxOutputTokens: 16384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		]);

		expect(runtime.provider).toMatchObject({ id: "custom-chat", name: "Custom Chat" });
		expect(runtime.model).toMatchObject({ id: "custom-model", api: "openai-chat-completions" });
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
			api: "openai-chat-completions",
		});
	});

	it("uses the built-in Zhipu provider from environment configuration", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "zhipu", ZAI_API_KEY: "test-key" }, []);

		expect(runtime.provider).toMatchObject({ id: "zhipu", name: "Zhipu AI" });
		expect(runtime.model).toMatchObject({
			id: "glm-5.3",
			provider: "zhipu",
			api: "openai-chat-completions",
		});
	});

	it("uses the built-in Kimi provider from environment configuration", () => {
		const runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "kimi", KIMI_API_KEY: "test-key" }, []);

		expect(runtime.provider).toMatchObject({ id: "kimi", name: "Kimi" });
		expect(runtime.model).toMatchObject({ id: "k3", provider: "kimi", api: "openai-chat-completions" });
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
			{ id: "deepseek", api: "openai-chat-completions" },
		]);

		expect(runtime.provider.id).toBe("deepseek");
		expect(runtime.model).toMatchObject({ id: "deepseek-v4-flash", api: "openai-chat-completions" });
	});

	it("allows a configured Zhipu provider to use the generated Coding Plan models", () => {
		const runtime = resolveStartupRuntime({ ZAI_API_KEY: "test-key" }, [
			{ id: "zhipu", api: "openai-chat-completions" },
		]);

		expect(runtime.provider.id).toBe("zhipu");
		expect(runtime.model).toMatchObject({ id: "glm-5.3", api: "openai-chat-completions" });
	});

	it("allows a configured Kimi provider to use generated Coding models", () => {
		const runtime = resolveStartupRuntime({ KIMI_API_KEY: "test-key" }, [
			{ id: "kimi", api: "openai-chat-completions" },
		]);

		expect(runtime.provider.id).toBe("kimi");
		expect(runtime.model).toMatchObject({ id: "k3", api: "openai-chat-completions" });
	});
});
