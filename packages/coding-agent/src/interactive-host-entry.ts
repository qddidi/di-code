import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { SessionStoreFactory } from "@di-code/builtins";
import {
	agentSessionKey,
	commandRegistryKey,
	hostCommandRegistryKey,
	interactiveContextKey,
	keybindingRegistryKey,
	modeRegistryKey,
	sessionStoreRegistryKey,
} from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { ProcessTerminal } from "@di-code/tui";
import { SessionManager } from "./core/session/session-manager.ts";
import { AgentSession } from "./core/session.ts";
import { workspaceStorageKey } from "./core/user-data.ts";
import { DEFAULT_LOCALE, translate } from "./i18n.ts";
import { mcpClientServiceKey, mcpConfigServiceKey, mcpToolServiceKey } from "./mcp/entries.ts";
import type { InteractiveSessionChoice } from "./modes/interactive.ts";
import { runInteractiveMode } from "./modes/interactive-entry.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import type { InteractiveHostRequest } from "./runtime/interactive-host-service.ts";
import { interactiveResourceServiceKey } from "./runtime/interactive-resource-service.ts";
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

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function sessionDirectory(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", workspaceStorageKey(cwd));
}

function newSessionPath(directory: string): string {
	return join(directory, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}.jsonl`);
}

async function openInteractiveSession(
	command: InteractiveHostRequest["command"],
	cwd: string,
	agentDir: string,
	store: SessionStoreFactory,
): Promise<SessionManager> {
	const directory = sessionDirectory(agentDir, cwd);
	if (command.sessionPath !== undefined) return await openJsonlSession(store, resolve(cwd, command.sessionPath));
	if (command.continueSession) {
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			const candidates = await Promise.all(
				entries
					.filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl")
					.map(async (entry) => ({
						path: join(directory, entry.name),
						modified: (await stat(join(directory, entry.name))).mtimeMs,
					})),
			);
			const recent = candidates.sort((left, right) => right.modified - left.modified)[0];
			if (recent) return await openJsonlSession(store, recent.path);
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		}
	}
	return await createJsonlSession(store, { filePath: newSessionPath(directory), cwd, deferCreate: true });
}

async function createJsonlSession(
	store: SessionStoreFactory,
	options: { readonly filePath: string; readonly cwd: string; readonly deferCreate?: boolean },
): Promise<SessionManager> {
	const session = await store.create(options);
	if (!(session instanceof SessionManager)) throw new Error("JSONL SessionStore returned an incompatible session.");
	return session;
}

async function openJsonlSession(store: SessionStoreFactory, filePath: string): Promise<SessionManager> {
	const session = await store.open(filePath);
	if (!(session instanceof SessionManager)) throw new Error("JSONL SessionStore returned an incompatible session.");
	return session;
}

function formatSessionLabel(manager: SessionManager): string {
	const fileName = basename(manager.filePath, extname(manager.filePath));
	const firstUserEntry = manager.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (firstUserEntry?.type !== "message" || firstUserEntry.message.role !== "user") return fileName;
	const question = firstUserEntry.message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return question.length > 72 ? `${question.slice(0, 69)}...` : question || fileName;
}

async function interactiveSessionChoices(
	directory: string,
	currentFile: string,
	openManager: (filePath: string) => Promise<SessionManager>,
	open: (filePath: string) => Promise<AgentSession>,
): Promise<readonly InteractiveSessionChoice[]> {
	let entries: readonly string[] = [];
	try {
		entries = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl")
			.map((entry) => entry.name)
			.sort();
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
	}
	return await Promise.all(
		entries
			.filter((name) => resolve(directory, name) !== resolve(currentFile))
			.map(async (name) => {
				const filePath = join(directory, name);
				let label = basename(name, extname(name));
				try {
					label = formatSessionLabel(await openManager(filePath));
				} catch {
					// Keep damaged sessions visible so opening one can show its recovery diagnostic.
				}
				return { id: basename(name, extname(name)), label, description: filePath, open: () => open(filePath) };
			}),
	);
}

/** Owns interactive resources, MCP connections, sessions, and the TUI command for the active composition. */
export const apiVersion = 1 as const;
export const name = "interactive-host";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = (context, _config, fiber) => {
	const host = context.require(hostCommandRegistryKey);
	const run = async (input: unknown, signal?: AbortSignal): Promise<number> => {
		if (!isInteractiveHostRequest(input)) throw new TypeError("Interactive host request is invalid");
		const request = input;
		const configuration = await loadStartupConfiguration(request.cwd, process.env, request.agentDir);
		const runtime = shouldStartProviderOnboarding(request.command, true, configuration)
			? await runProviderOnboarding({ configuration, terminal: new ProcessTerminal(), agentDir: request.agentDir })
			: resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
		if (!runtime) return 0;

		const loaded = await context.require(interactiveResourceServiceKey).load({
			cwd: request.cwd,
			agentDir: request.agentDir,
			projectTrusted: request.projectTrusted,
			noSkills: request.command.noSkills,
			noContextFiles: request.command.noContextFiles,
			skillPaths: request.command.skillPaths,
		});
		for (const diagnostic of loaded.resources.diagnostics) request.stderr(`${errorMessage(diagnostic.message)}\n`);

		const mcpConfig = context.require(mcpConfigServiceKey);
		const mcpClient = context.require(mcpClientServiceKey);
		const sessionStore = context.require(sessionStoreRegistryKey).get("jsonl");
		if (!sessionStore) throw new Error("JSONL SessionStore is unavailable in the interactive composition.");
		const configurations = await mcpConfig.load({ cwd: request.cwd, projectTrusted: request.projectTrusted });
		const mcp = await mcpClient.connect(configurations, { signal });
		try {
			const externalTools = context
				.require(mcpToolServiceKey)
				.create(mcp.servers, ["read", "write", "edit", "glob", "grep", "bash", "load_skill"]);
			const manager = await openInteractiveSession(request.command, request.cwd, request.agentDir, sessionStore);
			const createSession = async (sessionManager: SessionManager): Promise<AgentSession> => {
				const session = await context.require(agentSessionKey).create({
					allowedRoot: request.cwd,
					provider: runtime.provider,
					model: runtime.model,
					systemPrompt: loaded.systemPrompt,
					skills: loaded.resources.skills,
					sessionManager,
					externalTools,
				});
				if (!(session instanceof AgentSession))
					throw new Error("SessionFactory returned an incompatible interactive session.");
				return session;
			};
			const session = await createSession(manager);
			const directory = sessionDirectory(request.agentDir, request.cwd);
			const sessionChoices: readonly InteractiveSessionChoice[] = [
				{
					id: "new-session",
					label: translate(configuration.locale ?? DEFAULT_LOCALE, "newSession"),
					description: translate(configuration.locale ?? DEFAULT_LOCALE, "newSessionDescription"),
					open: async () =>
						await createSession(
							await createJsonlSession(sessionStore, {
								filePath: newSessionPath(directory),
								cwd: request.cwd,
								deferCreate: true,
							}),
						),
				},
				...(await interactiveSessionChoices(
					directory,
					manager.filePath,
					(filePath) => openJsonlSession(sessionStore, filePath),
					async (filePath) => createSession(await openJsonlSession(sessionStore, filePath)),
				)),
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
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				await context.require(modeRegistryKey).execute(
					"interactive",
					{
						run: () =>
							(request.startInteractiveMode ?? runInteractiveMode)({
								session,
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
			}
		} finally {
			await mcpClient.close(mcp.manager);
		}
	};
	fiber.addDisposer(host.register("interactive", run));
};
