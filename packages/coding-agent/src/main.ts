import { join } from "node:path";
import {
	ANTHROPIC_MODELS,
	createAnthropicProvider,
	createFauxProvider,
	createOpenAIProvider,
	type FauxResponse,
	OPENAI_MODELS,
} from "@di-code/ai";
import { ProcessTerminal, TUI } from "@di-code/tui";
import { type CliDependencies, runCli } from "./cli.ts";
import { loadModelsDocuments } from "./config/models-loader.ts";
import { loadSettings } from "./config/settings-loader.ts";
import type { ProviderName } from "./config/settings-types.ts";
import { FileModelCatalogStore } from "./core/model-catalog-store.ts";
import { composeProviderModels } from "./core/model-composer.ts";
import { AgentSession } from "./core/session.ts";
import { InteractiveMode } from "./modes/interactive.ts";
import { runJsonMode } from "./modes/json.ts";
import { type PrintIo, runPrintMode } from "./modes/print.ts";

export interface MainOptions extends PrintIo {
	readonly version: string;
	readonly fauxResponses: readonly FauxResponse[];
	readonly allowedRoot?: string;
	readonly now?: () => number;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly appData?: string;
	readonly interactive?: (session: AgentSession, initialPrompt: string) => Promise<number> | number;
	readonly modelCatalogPath?: string;
	readonly allowModelNetwork?: boolean;
}

export async function runMain(args: readonly string[], options: MainOptions): Promise<number> {
	const dependencies: CliDependencies = {
		stdout: options.stdout,
		stderr: options.stderr,
		version: options.version,
		run: async (command) => {
			try {
				const env = options.env ?? process.env;
				const loaded = await loadSettings({
					cwd: options.cwd ?? options.allowedRoot ?? process.cwd(),
					env,
					homeDir: options.homeDir,
					appData: options.appData,
				});
				const cwd = options.cwd ?? options.allowedRoot ?? process.cwd();
				const modelsDocument = await loadModelsDocuments([
					join(options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? cwd, ".di-code", "models.json"),
					join(cwd, ".di-code", "models.json"),
				]);
				const configuredProvider = loaded.settings.provider;
				const environmentProvider = env.DI_CODE_PROVIDER as ProviderName | undefined;
				const selectedProvider = command.provider ?? environmentProvider ?? configuredProvider ?? "faux";
				const providerSettings = loaded.settings.providers?.[selectedProvider];
				const customDefinition = modelsDocument.providers[selectedProvider];
				const runtime: { provider: import("@di-code/ai").Provider; models: readonly import("@di-code/ai").Model[] } =
					selectedProvider === "openai"
						? (() => {
								const provider = createOpenAIProvider({
									models: customDefinition
										? composeProviderModels("openai", OPENAI_MODELS, customDefinition)
										: undefined,
									env,
									apiKey: providerSettings?.apiKeyEnv ? env[providerSettings.apiKeyEnv] : env.OPENAI_API_KEY,
									baseUrl: env.OPENAI_BASE_URL ?? providerSettings?.baseUrl,
									now: options.now,
									catalogBaseUrl: env.DI_CODE_MODEL_CATALOG_URL,
									catalogStore: new FileModelCatalogStore(
										options.modelCatalogPath ??
											join(
												options.cwd ?? options.allowedRoot ?? process.cwd(),
												".di-code",
												"model-catalog-openai.json",
											),
									),
									allowModelNetwork: options.allowModelNetwork === true && env.DI_CODE_OFFLINE !== "1",
								});
								return { provider, models: provider.getModels?.() ?? provider.models };
							})()
						: selectedProvider === "anthropic"
							? (() => {
									const provider = createAnthropicProvider({
										models: customDefinition
											? composeProviderModels("anthropic", ANTHROPIC_MODELS, customDefinition)
											: undefined,
										env,
										apiKey: providerSettings?.apiKeyEnv ? env[providerSettings.apiKeyEnv] : env.ANTHROPIC_API_KEY,
										baseUrl: env.ANTHROPIC_BASE_URL ?? providerSettings?.baseUrl,
										now: options.now,
										catalogBaseUrl: env.DI_CODE_MODEL_CATALOG_URL,
										catalogStore: new FileModelCatalogStore(
											options.modelCatalogPath ??
												join(
													options.cwd ?? options.allowedRoot ?? process.cwd(),
													".di-code",
													"model-catalog-anthropic.json",
												),
										),
										allowModelNetwork: options.allowModelNetwork === true && env.DI_CODE_OFFLINE !== "1",
									});
									return { provider, models: provider.getModels?.() ?? provider.models };
								})()
							: customDefinition?.api === "openai-responses"
								? (() => {
										const models = composeProviderModels(selectedProvider, [], customDefinition);
										const provider = createOpenAIProvider({
											models,
											providerId: selectedProvider,
											providerName: customDefinition.name,
											env,
											apiKey: customDefinition.apiKeyEnv ? env[customDefinition.apiKeyEnv] : undefined,
											baseUrl: env.OPENAI_BASE_URL ?? customDefinition.baseUrl,
											now: options.now,
											catalogBaseUrl: env.DI_CODE_MODEL_CATALOG_URL,
											catalogStore: new FileModelCatalogStore(
												options.modelCatalogPath ?? join(cwd, ".di-code", `model-catalog-${selectedProvider}.json`),
											),
											allowModelNetwork: options.allowModelNetwork === true && env.DI_CODE_OFFLINE !== "1",
										});
										return { provider, models: provider.getModels?.() ?? provider.models };
									})()
								: customDefinition?.api === "anthropic-messages"
									? (() => {
											const models = composeProviderModels(selectedProvider, [], customDefinition);
											const provider = createAnthropicProvider({
												models,
												providerId: selectedProvider,
												providerName: customDefinition.name,
												env,
												apiKey: customDefinition.apiKeyEnv ? env[customDefinition.apiKeyEnv] : undefined,
												baseUrl: env.ANTHROPIC_BASE_URL ?? customDefinition.baseUrl,
												now: options.now,
												catalogBaseUrl: env.DI_CODE_MODEL_CATALOG_URL,
												catalogStore: new FileModelCatalogStore(
													options.modelCatalogPath ?? join(cwd, ".di-code", `model-catalog-${selectedProvider}.json`),
												),
												allowModelNetwork: options.allowModelNetwork === true && env.DI_CODE_OFFLINE !== "1",
											});
											return { provider, models: provider.getModels?.() ?? provider.models };
										})()
									: selectedProvider === "faux"
										? (() => {
												const faux = createFauxProvider({ responses: options.fauxResponses, now: options.now });
												return { provider: faux.provider, models: [faux.model] };
											})()
										: (() => {
												throw new Error(
													`Unknown provider "${selectedProvider}". Add it to models.json with a supported api.`,
												);
											})();
				if (runtime.provider.refreshModels) {
					try {
						await runtime.provider.refreshModels({
							store: new FileModelCatalogStore(
								options.modelCatalogPath ??
									join(
										options.cwd ?? options.allowedRoot ?? process.cwd(),
										".di-code",
										`model-catalog-${selectedProvider}.json`,
									),
							),
							allowNetwork: options.allowModelNetwork === true && env.DI_CODE_OFFLINE !== "1",
						});
					} catch (cause) {
						options.stderr(
							`Warning: model catalog refresh failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
						);
					}
				}
				runtime.models = runtime.provider.getModels?.() ?? runtime.provider.models;
				const modelEnvName =
					selectedProvider === "openai"
						? "OPENAI_MODEL"
						: selectedProvider === "anthropic"
							? "ANTHROPIC_MODEL"
							: undefined;
				const requestedModel = command.model ?? (modelEnvName ? env[modelEnvName] : undefined) ?? loaded.settings.model;
				const model =
					requestedModel !== undefined
						? runtime.models.find((candidate) => candidate.id === requestedModel)
						: runtime.models[0];
				if (!model) throw new Error(`Unknown ${selectedProvider} model "${requestedModel}".`);
				const session = new AgentSession({
					allowedRoot: options.allowedRoot ?? process.cwd(),
					provider: runtime.provider,
					model,
					now: options.now,
				});
				if (command.mode === "json") return runJsonMode(command.prompt, session, options);
				if (command.mode === "interactive") {
					if (options.interactive) return options.interactive(session, command.prompt);
					const terminal = new ProcessTerminal();
					const tui = new TUI(terminal);
					const mode = new InteractiveMode({ session, tui });
					mode.start(command.prompt);
					return 0;
				}
				return runPrintMode(command.prompt, session, options);
			} catch (cause) {
				options.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
				return 1;
			}
		},
	};

	return runCli(args, dependencies);
}
