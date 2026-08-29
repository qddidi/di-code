import { basename, extname, resolve } from "node:path";
import {
	commandRegistryKey,
	hostCommandRegistryKey,
	interactiveContextKey,
	keybindingRegistryKey,
	modeRegistryKey,
} from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { ProcessTerminal } from "@di-code/tui";
import { DEFAULT_LOCALE, translate } from "./i18n.ts";
import { runInteractiveMode } from "./modes/interactive-entry.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import type { InteractiveHostRequest } from "./runtime/interactive-host-service.ts";
import { createSessionHost } from "./runtime/session-host.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

function isInteractiveHostRequest(value: unknown): value is InteractiveHostRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"command" in value &&
		typeof value.command === "object" &&
		value.command !== null &&
		"mode" in value.command &&
		value.command.mode === "interactive" &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"agentDir" in value &&
		typeof value.agentDir === "string" &&
		"projectTrusted" in value &&
		typeof value.projectTrusted === "boolean" &&
		"stderr" in value &&
		typeof value.stderr === "function"
	);
}

/** Owns the interactive ProductHost and gives the presentation mode only its UiHost facade. */
export const apiVersion = 1 as const;
export const name = "interactive-host";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = (context, _config, fiber) => {
	const registry = context.require(hostCommandRegistryKey);
	const run = async (input: unknown, signal?: AbortSignal): Promise<number> => {
		if (!isInteractiveHostRequest(input)) throw new TypeError("Interactive host request is invalid");
		const request = input;
		const configuration = await loadStartupConfiguration(request.cwd, process.env, request.agentDir);
		const runtime = shouldStartProviderOnboarding(request.command, true, configuration)
			? await runProviderOnboarding({ configuration, terminal: new ProcessTerminal(), agentDir: request.agentDir })
			: resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
		if (!runtime) return 0;
		const host = await createSessionHost(context, {
			cwd: request.cwd,
			agentDir: request.agentDir,
			projectTrusted: request.projectTrusted,
			noSkills: request.command.noSkills,
			noContextFiles: request.command.noContextFiles,
			skillPaths: request.command.skillPaths,
			provider: runtime.provider,
			model: runtime.model,
			signal,
			planMode: {
				section: "You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.",
			},
			...(request.command.sessionPath ? { initialSessionPath: resolve(request.cwd, request.command.sessionPath) } : {}),
		});
		if (!host.state().activeSession) await host.createSession();
		const ui = host.ui();
		const sessions = await host.listSessions();
		const activeId = host.state().activeSession?.id;
		const sessionChoices = [
			{
				id: "new-session",
				label: translate(configuration.locale ?? DEFAULT_LOCALE, "newSession"),
				description: translate(configuration.locale ?? DEFAULT_LOCALE, "newSessionDescription"),
				open: async () => {
					await host.createSession();
					return host.ui();
				},
			},
			...sessions
				.filter((item) => item.id !== activeId)
				.map((item) => ({
					id: item.displayId ?? item.id,
					label: item.label || basename(item.id, extname(item.id)),
					description: item.cwd,
					open: async () => {
						await host.openSession(item.id);
						return host.ui();
					},
				})),
		];
		let mode: import("./modes/interactive.ts").InteractiveMode | undefined;
		let selectedTheme = "dark";
		const unbind = context.require(interactiveContextKey).bind({
			sessionChoices: () => sessionChoices,
			cancel: () => mode?.cancelActivePrompt(),
			retry: () => mode?.retryLastPrompt(),
			theme: () => selectedTheme,
			setTheme: (theme) => {
				selectedTheme = theme;
			},
			keybindings: () => context.get(keybindingRegistryKey)?.snapshot(),
		});
		try {
			let finish: (() => void) | undefined;
			const finished = new Promise<void>((resolveFinish) => {
				finish = resolveFinish;
			});
			await context.require(modeRegistryKey).execute(
				"interactive",
				{
					run: () =>
						(request.startInteractiveMode ?? runInteractiveMode)({
							session: ui,
							agentDir: request.agentDir,
							locale: configuration.locale ?? DEFAULT_LOCALE,
							commandRegistry: context.require(commandRegistryKey),
							context: context.require(interactiveContextKey),
							providerOnboarding: { configuration, agentDir: request.agentDir },
							initialPrompt: request.command.prompt,
							onCreated: (created) => {
								mode = created;
							},
							onExit: () => finish?.(),
						}),
				},
				signal,
			);
			await finished;
			return 0;
		} finally {
			unbind();
			await host.dispose();
		}
	};
	fiber.addDisposer(registry.register("interactive", run));
};
