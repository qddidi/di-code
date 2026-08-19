import { createFauxProvider, MODELS, type Model, type ModelApi } from "@di-code/ai";
import {
	Box,
	Input,
	Key,
	KeybindingsManager,
	type SelectItem,
	SelectList,
	type Terminal,
	Text,
	TUI,
} from "@di-code/tui";
import type { CliCommand } from "./cli.ts";
import { DEFAULT_LOCALE, type Locale, translate } from "./i18n.ts";
import {
	resolveStartupRuntime,
	type StartupConfiguration,
	type StartupRuntime,
	saveGlobalCustomProvider,
	saveGlobalProviderApiKey,
	validateCustomBaseUrl,
} from "./startup.ts";

export type StartupRunCommand = Extract<CliCommand, { kind: "run" }>;

export interface ProviderOnboardingOptions {
	readonly configuration: StartupConfiguration;
	readonly terminal: Terminal;
	readonly agentDir: string;
}

export interface InteractiveProviderOnboardingOptions {
	readonly configuration: StartupConfiguration;
	readonly agentDir: string;
	readonly tui: TUI;
}

export function shouldStartProviderOnboarding(
	command: StartupRunCommand,
	isInteractiveTerminal: boolean,
	configuration: StartupConfiguration,
): boolean {
	return (
		command.mode === "interactive" &&
		isInteractiveTerminal &&
		!configuration.environment.DI_CODE_PROVIDER?.trim() &&
		!configuration.defaults?.providerId &&
		configuration.providers.length !== 1
	);
}

interface OnboardingChoice extends SelectItem {
	readonly providerId: "openai" | "deepseek" | "kimi" | "zhipu" | "anthropic" | "faux" | "custom";
}

class OnboardingScreen {
	private readonly prompt = new Text("", 1, 0);
	private readonly error = new Text("", 1, 0);
	private active: SelectList | Input | null = null;

	setStep(prompt: string, active: SelectList | Input): void {
		this.prompt.setText(prompt);
		this.error.setText("");
		this.active = active;
	}

	setError(message: string): void {
		this.error.setText(message);
	}

	setCancelled(locale: Locale): void {
		this.prompt.setText(translate(locale, "providerSetupCancelled"));
		this.error.setText("");
		this.active = null;
	}

	render(width: number): string[] {
		return [...this.prompt.render(width), ...this.error.render(width), ...(this.active?.render(width) ?? [])];
	}

	invalidate(): void {
		this.prompt.invalidate();
		this.error.invalidate();
		this.active?.invalidate();
	}
}

function providerChoices(locale: Locale): OnboardingChoice[] {
	return [
		{ value: "openai", providerId: "openai", label: "OpenAI", description: "OpenAI Responses API" },
		{ value: "deepseek", providerId: "deepseek", label: "DeepSeek", description: "DeepSeek Chat Completions API" },
		{ value: "faux", providerId: "faux", label: "Faux (offline)", description: translate(locale, "fauxProvider") },
		{ value: "zhipu", providerId: "zhipu", label: "Zhipu AI", description: "GLM Chat Completions API" },
		{ value: "anthropic", providerId: "anthropic", label: "Anthropic", description: "Claude Messages API" },
		{
			value: "custom",
			providerId: "custom",
			label: translate(locale, "customProvider"),
			description: translate(locale, "customProviderDescription"),
		},
		{ value: "kimi", providerId: "kimi", label: "Kimi", description: "Kimi Coding Chat Completions API" },
	];
}

function modelsFor(providerId: OnboardingChoice["providerId"]): readonly Model[] {
	if (providerId === "custom") return [];
	if (providerId === "faux") return [createFauxProvider({ responses: [] }).model];
	const models = MODELS.filter((model) => model.provider === providerId);
	if (providerId === "openai") {
		const preferred = models.find((model) => model.id === "gpt-4o");
		return preferred ? [preferred, ...models.filter((model) => model !== preferred)] : models;
	}
	if (providerId === "zhipu") {
		const preferred = models.find((model) => model.id === "glm-5.3");
		return preferred ? [preferred, ...models.filter((model) => model !== preferred)] : models;
	}
	if (providerId === "anthropic") {
		const preferred = models.find((model) => model.id === "claude-sonnet-4-5");
		return preferred ? [preferred, ...models.filter((model) => model !== preferred)] : models;
	}
	return models;
}

function apiKeyEnvironmentVariable(providerId: OnboardingChoice["providerId"]): string | undefined {
	if (providerId === "openai") return "OPENAI_API_KEY";
	if (providerId === "deepseek") return "DEEPSEEK_API_KEY";
	if (providerId === "kimi") return "KIMI_API_KEY";
	if (providerId === "zhipu") return "ZAI_API_KEY";
	if (providerId === "anthropic") return "ANTHROPIC_API_KEY";
	return undefined;
}

function providerApi(providerId: OnboardingChoice["providerId"]): Exclude<ModelApi, "faux"> | undefined {
	if (providerId === "openai") return "openai-responses";
	if (providerId === "deepseek" || providerId === "zhipu") return "openai-chat-completions";
	if (providerId === "kimi") return "openai-chat-completions";
	if (providerId === "anthropic") return "anthropic-messages";
	return undefined;
}

function customApiChoices(): SelectItem[] {
	return [
		{ value: "openai-responses", label: "OpenAI Responses", description: "OpenAI Responses API" },
		{
			value: "openai-chat-completions",
			label: "OpenAI Chat Completions",
			description: "Chat Completions-compatible API",
		},
		{ value: "anthropic-messages", label: "Anthropic Messages", description: "Anthropic Messages API" },
	];
}

function modelChoices(models: readonly Model[], locale: Locale): SelectItem[] {
	return models.map((model) => ({
		value: model.id,
		label: model.name,
		description: `${model.id}${model.reasoning ? ` - ${translate(locale, "reasoning")}` : ""}`,
	}));
}

function onboardingSelectList(items: readonly SelectItem[]): SelectList {
	return new SelectList(items, {
		keybindings: new KeybindingsManager({
			"tui.select.cancel": [Key.escape, Key.ctrl("c"), Key.ctrl("d")],
		}),
	});
}

function startProviderOnboarding(
	options: Pick<ProviderOnboardingOptions, "configuration" | "agentDir">,
	tui: TUI,
	screen: OnboardingScreen,
	complete: (runtime: StartupRuntime | undefined) => void,
	failure: () => void,
	forceApiKey: boolean,
): Promise<StartupRuntime | undefined> {
	return new Promise((resolve, reject) => {
		const locale = options.configuration.locale ?? DEFAULT_LOCALE;
		let settled = false;
		let saving = false;
		let selectedProvider: OnboardingChoice["providerId"] | undefined;

		const finish = (runtime: StartupRuntime | undefined): void => {
			if (settled) return;
			settled = true;
			if (runtime === undefined) screen.setCancelled(locale);
			complete(runtime);
			resolve(runtime);
		};

		const fail = (cause: unknown): void => {
			if (settled) return;
			settled = true;
			failure();
			reject(cause);
		};

		const finishSelection = async (modelId: string, apiKey?: string): Promise<void> => {
			if (!selectedProvider || saving || settled) return;
			saving = true;
			const keyVariable = apiKeyEnvironmentVariable(selectedProvider);
			const environment = {
				...options.configuration.environment,
				DI_CODE_PROVIDER: selectedProvider,
				DI_CODE_MODEL: modelId,
				...(keyVariable && apiKey ? { [keyVariable]: apiKey } : {}),
			};
			try {
				const api = providerApi(selectedProvider);
				if (apiKey && api) await saveGlobalProviderApiKey(options.agentDir, selectedProvider, api, apiKey, modelId);
				finish(resolveStartupRuntime(environment, options.configuration.providers));
			} catch (cause) {
				fail(cause);
			}
		};

		const showKey = (modelId: string, keyVariable: string): void => {
			const input = new Input({ mask: "*", cancelOnEndOfTransmission: true });
			input.onSubmit = (value) => {
				const key = value.trim();
				if (key.length === 0) {
					screen.setError(translate(locale, "apiKeyRequired"));
					tui.requestRender(true);
					return;
				}
				void finishSelection(modelId, key);
			};
			input.onEscape = () => finish(undefined);
			screen.setStep(translate(locale, "enterApiKey", keyVariable), input);
			tui.setFocus(input);
			tui.requestRender(true);
		};

		const showModels = (choice: OnboardingChoice): void => {
			selectedProvider = choice.providerId;
			const models = modelsFor(choice.providerId);
			const modelList = onboardingSelectList(modelChoices(models, locale));
			modelList.onSelect = (item) => {
				const keyVariable = apiKeyEnvironmentVariable(choice.providerId);
				const existingKey = keyVariable ? options.configuration.environment[keyVariable]?.trim() : undefined;
				if (keyVariable && (forceApiKey || !existingKey)) showKey(item.value, keyVariable);
				else void finishSelection(item.value);
			};
			modelList.onCancel = () => finish(undefined);
			screen.setStep(translate(locale, "selectProviderModel", choice.label), modelList);
			tui.setFocus(modelList);
			tui.requestRender(true);
		};

		const showCustom = (): void => {
			const protocolList = onboardingSelectList(customApiChoices());
			protocolList.onSelect = (item) => {
				const api = item.value as Exclude<ModelApi, "faux">;
				const baseUrlInput = new Input({ cancelOnEndOfTransmission: true });
				baseUrlInput.onSubmit = (value) => {
					let baseUrl: string;
					try {
						baseUrl = validateCustomBaseUrl(value);
					} catch (cause) {
						screen.setError(cause instanceof Error ? cause.message : translate(locale, "customBaseUrlInvalid"));
						tui.requestRender(true);
						return;
					}
					const keyInput = new Input({ mask: "*", cancelOnEndOfTransmission: true });
					keyInput.onSubmit = (keyValue) => {
						const apiKey = keyValue.trim();
						if (!apiKey) {
							screen.setError(translate(locale, "apiKeyRequired"));
							tui.requestRender(true);
							return;
						}
						const modelInput = new Input({ cancelOnEndOfTransmission: true });
						modelInput.onSubmit = (modelValue) => {
							const modelId = modelValue.trim();
							if (!modelId) {
								screen.setError(translate(locale, "modelIdRequired"));
								tui.requestRender(true);
								return;
							}
							if (saving || settled) return;
							saving = true;
							void saveGlobalCustomProvider(options.agentDir, { api, baseUrl, apiKey, modelId })
								.then((custom) => {
									const providers = [
										...options.configuration.providers.filter((provider) => provider.id !== "custom"),
										custom,
									];
									finish(
										resolveStartupRuntime(
											{ ...options.configuration.environment, DI_CODE_PROVIDER: "custom", DI_CODE_MODEL: modelId },
											providers,
											{ providerId: "custom", modelId },
										),
									);
								})
								.catch(fail);
						};
						modelInput.onEscape = () => finish(undefined);
						screen.setStep(translate(locale, "enterCustomModelId"), modelInput);
						tui.setFocus(modelInput);
						tui.requestRender(true);
					};
					keyInput.onEscape = () => finish(undefined);
					screen.setStep(translate(locale, "enterCustomApiKey"), keyInput);
					tui.setFocus(keyInput);
					tui.requestRender(true);
				};
				baseUrlInput.onEscape = () => finish(undefined);
				screen.setStep(translate(locale, "enterCustomBaseUrl"), baseUrlInput);
				tui.setFocus(baseUrlInput);
				tui.requestRender(true);
			};
			protocolList.onCancel = () => finish(undefined);
			screen.setStep(translate(locale, "selectCustomApi"), protocolList);
			tui.setFocus(protocolList);
			tui.requestRender(true);
		};

		const providerList = onboardingSelectList(providerChoices(locale));
		providerList.onSelect = (item) => {
			const choice = providerChoices(locale).find((candidate) => candidate.value === item.value);
			if (choice?.providerId === "custom") showCustom();
			else if (choice) showModels(choice);
		};
		providerList.onCancel = () => finish(undefined);
		screen.setStep(translate(locale, "selectProvider"), providerList);
		tui.setFocus(providerList);
		tui.requestRender(true);
	});
}

export function runProviderOnboarding(options: ProviderOnboardingOptions): Promise<StartupRuntime | undefined> {
	const tui = new TUI(options.terminal);
	const screen = new OnboardingScreen();
	const locale = options.configuration.locale ?? DEFAULT_LOCALE;
	tui.addChild(new Box(screen, { border: "rounded", padding: 1, title: translate(locale, "providerSetup") }));
	tui.start();
	return startProviderOnboarding(
		options,
		tui,
		screen,
		(runtime) => {
			tui.stop({
				finalLines: [translate(locale, runtime ? "providerConfigured" : "providerSetupCancelled")],
			});
		},
		() => tui.stop({ finalLines: [translate(locale, "providerSetupFailed")] }),
		false,
	);
}

export function showInteractiveProviderOnboarding(
	options: InteractiveProviderOnboardingOptions,
): Promise<StartupRuntime | undefined> {
	const screen = new OnboardingScreen();
	const locale = options.configuration.locale ?? DEFAULT_LOCALE;
	const panel = new Box(screen, { border: "rounded", padding: 1, title: translate(locale, "login") });
	const overlay = options.tui.showOverlay(panel, {
		width: "70%",
		maxHeight: "60%",
		anchor: "center",
		margin: 1,
	});
	return startProviderOnboarding(
		options,
		options.tui,
		screen,
		() => overlay.hide(),
		() => overlay.hide(),
		true,
	);
}
