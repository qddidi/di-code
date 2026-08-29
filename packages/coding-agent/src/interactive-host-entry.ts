import { basename, extname, resolve } from "node:path";
import {
	commandRegistryKey,
	hostCommandRegistryKey,
	interactiveContextKey,
	keybindingRegistryKey,
	modeRegistryKey,
} from "@di-code/builtins";
import type { PluginInventory } from "@di-code/plugin-loader";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { redactSensitiveText } from "@di-code/plugin-runtime";
import { createUserInteraction } from "@di-code/plugin-sdk";
import { ProcessTerminal } from "@di-code/tui";
import { DEFAULT_LOCALE, translate } from "./i18n.ts";
import { runInteractiveMode } from "./modes/interactive-entry.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import type { InteractiveHostRequest } from "./runtime/interactive-host-service.ts";
import { pluginInventoryKey } from "./runtime/plugin-inventory-service.ts";
import { createSessionHost, type SessionStartupStatus } from "./runtime/session-host.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

const ANSI = {
	reset: "\u001b[0m",
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	cyan: "\u001b[36m",
	blue: "\u001b[34m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	red: "\u001b[31m",
	gray: "\u001b[90m",
	magenta: "\u001b[35m",
} as const;

function paint(value: string, color: keyof typeof ANSI): string {
	return `${ANSI[color]}${value}${ANSI.reset}`;
}

function paintStatus(status: string): string {
	const color =
		status === "active" || status === "connected"
			? "green"
			: status === "failed"
				? "red"
				: status === "disabled"
					? "gray"
					: "yellow";
	return paint(status, color);
}

function printStartupResources(
	request: InteractiveHostRequest,
	inventory: PluginInventory | undefined,
	startup: SessionStartupStatus,
): void {
	const projectEntries =
		inventory?.entries.filter(
			(record) => record.entry.projectLocal || record.entry.id.startsWith("managed.") || record.status === "failed",
		) ?? [];
	const hasDetails =
		projectEntries.length > 0 ||
		startup.skills.length > 0 ||
		startup.resourceDiagnostics.length > 0 ||
		startup.mcpServers.length > 0 ||
		startup.mcpDiagnostics.length > 0;
	if (!hasDetails) return;
	const lines = ["", `${paint("di-code startup resources", "bold")}:`, `  ${paint("Plugins", "cyan")}:`];
	if (projectEntries.length === 0) lines.push(`    ${paint("- none", "dim")}`);
	for (const record of projectEntries) {
		const reason = record.error ? `: ${redactSensitiveText(record.error.message)}` : "";
		lines.push(`    - ${record.entry.id}: ${paintStatus(record.status)}${reason}`);
	}
	lines.push(`  ${paint("Skills", "magenta")}:`);
	if (startup.skills.length === 0) lines.push(`    ${paint("- none", "dim")}`);
	for (const skill of startup.skills)
		lines.push(`    - ${paint(skill.name, "magenta")} ${paint(`(${skill.scope})`, "dim")}`);
	for (const diagnostic of startup.resourceDiagnostics)
		lines.push(
			`    - ${paint(`${diagnostic.kind} ${diagnostic.severity}`, diagnostic.severity === "error" ? "red" : "yellow")}: ${diagnostic.path}: ${diagnostic.message}`,
		);
	lines.push(`  ${paint("MCP", "blue")}:`);
	if (startup.mcpServers.length === 0 && startup.mcpDiagnostics.length === 0)
		lines.push(`    ${paint("- none", "dim")}`);
	for (const server of startup.mcpServers)
		lines.push(
			`    - ${server.id}: ${paintStatus("connected")} ${paint(`(tools ${server.tools}, resources ${server.resources}, prompts ${server.prompts})`, "dim")}`,
		);
	for (const diagnostic of startup.mcpDiagnostics)
		lines.push(
			`    - ${diagnostic.serverId}: ${paintStatus("failed")} (${diagnostic.stage}): ${redactSensitiveText(diagnostic.message)}`,
		);
	request.stderr(`${lines.join("\n")}\n\n`);
}

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
		let mode: import("./modes/interactive.ts").InteractiveMode | undefined;
		const interaction = createUserInteraction({
			request: (input, interactionSignal) => {
				if (!mode) throw new Error("Interactive mode is not ready.");
				return mode.requestInteraction(input, interactionSignal);
			},
		});
		let host: Awaited<ReturnType<typeof createSessionHost>>;
		try {
			host = await createSessionHost(context, {
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
					section:
						"You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.",
				},
				interaction,
				...(request.command.sessionPath
					? { initialSessionPath: resolve(request.cwd, request.command.sessionPath) }
					: {}),
			});
		} catch (cause) {
			printStartupResources(request, context.get(pluginInventoryKey)?.snapshot(), {
				skills: [],
				resourceDiagnostics: [
					{
						path: request.cwd,
						kind: "startup",
						stage: "load",
						severity: "error",
						message: redactSensitiveText(cause instanceof Error ? cause.message : String(cause)),
					},
				],
				mcpServers: [],
				mcpDiagnostics: [],
			});
			throw cause;
		}
		if (!host.state().activeSession) await host.createSession();
		const ui = host.ui();
		printStartupResources(request, context.get(pluginInventoryKey)?.snapshot(), host.startupStatus());
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
			await interaction.dispose();
			await host.dispose();
		}
	};
	fiber.addDisposer(registry.register("interactive", run));
};
