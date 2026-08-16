import { createFauxProvider, MODELS, type Model } from "@di-code/ai";
import { Input, Key, KeybindingsManager, type SelectItem, SelectList, type Terminal, Text, TUI } from "@di-code/tui";
import type { CliCommand } from "./cli.ts";
import { resolveStartupRuntime, type StartupConfiguration, type StartupRuntime } from "./startup.ts";

export type StartupRunCommand = Extract<CliCommand, { kind: "run" }>;

export interface ProviderOnboardingOptions {
	readonly configuration: StartupConfiguration;
	readonly terminal: Terminal;
}

export function shouldStartProviderOnboarding(
	command: StartupRunCommand,
	isInteractiveTerminal: boolean,
	configuration: StartupConfiguration,
): boolean {
	return (
		command.mode === "interactive" &&
		isInteractiveTerminal &&
		configuration.providers.length === 0 &&
		!configuration.environment.DI_CODE_PROVIDER?.trim()
	);
}

interface OnboardingChoice extends SelectItem {
	readonly providerId: "openai" | "deepseek" | "zhipu" | "faux";
}

class OnboardingScreen {
	private readonly title = new Text("di-code provider setup", 1, 1);
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

	setCancelled(): void {
		this.prompt.setText("Provider setup cancelled.");
		this.error.setText("");
		this.active = null;
	}

	render(width: number): string[] {
		return [
			...this.title.render(width),
			...this.prompt.render(width),
			...this.error.render(width),
			...(this.active?.render(width) ?? []),
		];
	}

	invalidate(): void {
		this.title.invalidate();
		this.prompt.invalidate();
		this.error.invalidate();
		this.active?.invalidate();
	}
}

function providerChoices(): OnboardingChoice[] {
	return [
		{ value: "openai", providerId: "openai", label: "OpenAI", description: "OpenAI Responses API" },
		{ value: "deepseek", providerId: "deepseek", label: "DeepSeek", description: "DeepSeek Responses API" },
		{ value: "faux", providerId: "faux", label: "Faux (offline)", description: "Deterministic local provider" },
		{ value: "zhipu", providerId: "zhipu", label: "Zhipu AI", description: "GLM Chat Completions API" },
	];
}

function modelsFor(providerId: OnboardingChoice["providerId"]): readonly Model[] {
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
	return models;
}

function apiKeyEnvironmentVariable(providerId: OnboardingChoice["providerId"]): string | undefined {
	if (providerId === "openai") return "OPENAI_API_KEY";
	if (providerId === "deepseek") return "DEEPSEEK_API_KEY";
	if (providerId === "zhipu") return "ZAI_API_KEY";
	return undefined;
}

function modelChoices(models: readonly Model[]): SelectItem[] {
	return models.map((model) => ({
		value: model.id,
		label: model.name,
		description: `${model.id}${model.reasoning ? " - reasoning" : ""}`,
	}));
}

function onboardingSelectList(items: readonly SelectItem[]): SelectList {
	return new SelectList(items, {
		keybindings: new KeybindingsManager({
			"tui.select.cancel": [Key.escape, Key.ctrl("c"), Key.ctrl("d")],
		}),
	});
}

export function runProviderOnboarding(options: ProviderOnboardingOptions): Promise<StartupRuntime | undefined> {
	return new Promise((resolve, reject) => {
		const tui = new TUI(options.terminal);
		const screen = new OnboardingScreen();
		let settled = false;
		let selectedProvider: OnboardingChoice["providerId"] | undefined;

		const finish = (runtime: StartupRuntime | undefined): void => {
			if (settled) return;
			settled = true;
			if (runtime === undefined) screen.setCancelled();
			tui.stop({ finalLines: runtime ? ["Provider configured for this run."] : ["Provider setup cancelled."] });
			resolve(runtime);
		};

		const fail = (cause: unknown): void => {
			if (settled) return;
			settled = true;
			tui.stop({ finalLines: ["Provider setup failed."] });
			reject(cause);
		};

		const finishSelection = (modelId: string, apiKey?: string): void => {
			if (!selectedProvider) return;
			const keyVariable = apiKeyEnvironmentVariable(selectedProvider);
			const environment = {
				...options.configuration.environment,
				DI_CODE_PROVIDER: selectedProvider,
				DI_CODE_MODEL: modelId,
				...(keyVariable && apiKey ? { [keyVariable]: apiKey } : {}),
			};
			try {
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
					screen.setError("API key cannot be empty. Press Escape to cancel.");
					tui.requestRender(true);
					return;
				}
				finishSelection(modelId, key);
			};
			input.onEscape = () => finish(undefined);
			screen.setStep(`Enter ${keyVariable} (input is hidden):`, input);
			tui.setFocus(input);
			tui.requestRender(true);
		};

		const showModels = (choice: OnboardingChoice): void => {
			selectedProvider = choice.providerId;
			const models = modelsFor(choice.providerId);
			const modelList = onboardingSelectList(modelChoices(models));
			modelList.onSelect = (item) => {
				const keyVariable = apiKeyEnvironmentVariable(choice.providerId);
				const existingKey = keyVariable ? options.configuration.environment[keyVariable]?.trim() : undefined;
				if (keyVariable && !existingKey) showKey(item.value, keyVariable);
				else finishSelection(item.value);
			};
			modelList.onCancel = () => finish(undefined);
			screen.setStep(`Select a ${choice.label} model:`, modelList);
			tui.setFocus(modelList);
			tui.requestRender(true);
		};

		const providerList = onboardingSelectList(providerChoices());
		providerList.onSelect = (item) => {
			const choice = providerChoices().find((candidate) => candidate.value === item.value);
			if (choice) showModels(choice);
		};
		providerList.onCancel = () => finish(undefined);
		screen.setStep("Select a provider:", providerList);
		tui.addChild(screen);
		tui.start();
		tui.setFocus(providerList);
		tui.requestRender(true);
	});
}
