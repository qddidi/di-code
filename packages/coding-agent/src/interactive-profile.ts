import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
	agentSessionKey,
	commandRegistryKey,
	type InteractiveContextService,
	keybindingRegistryKey,
	modeRegistryKey,
} from "@di-code/builtins";
import { createCompositionLoader, type PluginModule, ProjectTrustStore } from "@di-code/plugin-loader";
import { createRootContext, type RuntimeEvent, redactSensitiveText } from "@di-code/plugin-runtime";
import { ProcessTerminal } from "@di-code/tui";
import { type CliCommand, createCliParser } from "./cli.ts";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveManagedCompositionEntries,
} from "./compositions.ts";
import { loadResources } from "./core/resources/loader.ts";
import { SessionManager } from "./core/session/session-manager.ts";
import { AgentSession } from "./core/session.ts";
import { buildSystemPrompt } from "./core/system-prompt.ts";
import { workspaceStorageKey } from "./core/user-data.ts";
import { DEFAULT_LOCALE, translate } from "./i18n.ts";
import { mcpClientServiceKey, mcpConfigServiceKey, mcpToolServiceKey } from "./mcp/entries.ts";
import type { InteractiveSessionChoice } from "./modes/interactive.ts";
import { type InteractiveModeEntryOptions, runInteractiveMode } from "./modes/interactive-entry.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import { pluginInventoryKey } from "./runtime/plugin-inventory-entry.ts";
import { installAgentSessionFactory } from "./runtime/session-factory.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

export interface InteractiveProfileOptions {
	readonly stderr: (text: string) => void;
	readonly allowedRoot?: string;
	readonly agentDir?: string;
	readonly isInteractiveTerminal: boolean;
	readonly promptProjectTrust?: (cwd: string) => Promise<boolean>;
	readonly onRuntimeEvent?: (event: RuntimeEvent) => void;
	/** Test-only terminal boundary; production uses the composition-owned mode entry. */
	readonly startInteractiveMode?: (options: InteractiveModeEntryOptions) => number;
	/** Test-only module boundary; production uses the namespace composition importer. */
	readonly importModule?: (name: string) => Promise<PluginModule>;
}

function errorMessage(cause: unknown): string {
	return redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
}

function isInteractiveRun(
	command: CliCommand,
): command is Extract<CliCommand, { kind: "run" }> & { readonly mode: "interactive" } {
	return command.kind === "run" && command.mode === "interactive";
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
		throw cause;
	}
}

async function hasTrustedProjectContent(cwd: string): Promise<boolean> {
	for (const path of [
		join(cwd, ".di-code", "skills"),
		join(cwd, ".agents", "skills"),
		join(cwd, ".di-code", "mcp.local.json"),
		join(cwd, ".mcp.json"),
	]) {
		if (await exists(path)) return true;
	}
	return false;
}

function sessionDirectory(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", workspaceStorageKey(cwd));
}

function newSessionPath(directory: string): string {
	return join(directory, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}.jsonl`);
}

async function openInteractiveSession(
	command: Extract<CliCommand, { kind: "run" }>,
	cwd: string,
	agentDir: string,
): Promise<SessionManager> {
	const directory = sessionDirectory(agentDir, cwd);
	if (command.sessionPath !== undefined) return await SessionManager.open(resolve(cwd, command.sessionPath));
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
			if (recent) return await SessionManager.open(recent.path);
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		}
	}
	return await SessionManager.create({ filePath: newSessionPath(directory), cwd, deferCreate: true });
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
					label = formatSessionLabel(await SessionManager.open(filePath));
				} catch {
					// Retain corrupted files as choices so their detailed recovery diagnostic remains visible on open.
				}
				return { id: basename(name, extname(name)), label, description: filePath, open: () => open(filePath) };
			}),
	);
}

/** Starts interactive TUI through the default composition without importing legacy plugin or extension hosts. */
export async function runInteractiveProfile(
	args: readonly string[],
	options: InteractiveProfileOptions,
): Promise<number> {
	const parser = createCliParser();
	let command: CliCommand;
	try {
		command = parser.parse(args);
	} catch (cause) {
		options.stderr(`${errorMessage(cause)}\n`);
		return 1;
	}
	if (!isInteractiveRun(command)) {
		options.stderr("Interactive profile requires --interactive or --mode interactive.\n");
		return 1;
	}
	if (!options.isInteractiveTerminal) {
		options.stderr("Interactive mode requires an interactive TTY.\n");
		return 1;
	}

	const cwd = resolve(options.allowedRoot ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
	const trustStore = new ProjectTrustStore(join(agentDir, "trust.json"));
	try {
		if (command.projectTrust !== undefined) await trustStore.set(cwd, command.projectTrust);
		let projectTrusted = (await trustStore.get(cwd)) === true;
		if (
			!projectTrusted &&
			command.projectTrust === undefined &&
			options.promptProjectTrust &&
			(await hasTrustedProjectContent(cwd))
		) {
			try {
				projectTrusted = await options.promptProjectTrust(cwd);
			} catch {
				projectTrusted = false;
			}
			await trustStore.set(cwd, projectTrusted);
		}

		const configuration = await loadStartupConfiguration(cwd, process.env, agentDir);
		const runtime = shouldStartProviderOnboarding(command, true, configuration)
			? await runProviderOnboarding({ configuration, terminal: new ProcessTerminal(), agentDir })
			: resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
		if (!runtime) return 0;

		const context = createRootContext({
			id: "interactive-profile",
			mode: "interactive",
			trustedProject: projectTrusted,
		});
		const compositionEntries = await resolveCompositionEntries(command.profile ?? command.mode, {
			cwd,
			agentDir,
			...(command.compositionPath ? { compositionPath: command.compositionPath } : {}),
			includeProjectComposition: projectTrusted && !command.noProjectPlugins,
			allowedRoot: cwd,
		});
		const unsubscribe = context.events.subscribe((event) => options.onRuntimeEvent?.(event));
		const loader = createCompositionLoader({
			context,
			entries: [...compositionEntries, ...(await resolveManagedCompositionEntries(agentDir))],
			importModule: options.importModule ?? importCompositionModule,
			projectTrusted,
		});
		let closed = false;
		let closeMcp: (() => Promise<void>) | undefined;
		let removeSessionFactory: (() => void | Promise<void>) | undefined;
		const close = async (): Promise<void> => {
			if (closed) return;
			closed = true;
			try {
				await closeMcp?.();
			} finally {
				try {
					await removeSessionFactory?.();
					await loader.dispose();
				} finally {
					await context.dispose();
					unsubscribe();
				}
			}
		};
		try {
			await loader.load();
			removeSessionFactory = installAgentSessionFactory(context);
			context.require(pluginInventoryKey).set(loader.tree.snapshot());
			const resources = await loadResources({
				cwd,
				agentDir,
				projectTrusted,
				noSkills: command.noSkills,
				noContextFiles: command.noContextFiles,
				skillPaths: command.skillPaths,
			});
			for (const diagnostic of resources.diagnostics) options.stderr(`${errorMessage(diagnostic.message)}\n`);
			const configurations = await context.require(mcpConfigServiceKey).load({ cwd, projectTrusted });
			const mcp = await context.require(mcpClientServiceKey).connect(configurations);
			closeMcp = async () => {
				await mcp.manager.close();
			};
			const externalTools = context
				.require(mcpToolServiceKey)
				.create(mcp.servers, ["read", "write", "edit", "glob", "grep", "bash", "load_skill"]);
			const manager = await openInteractiveSession(command, cwd, agentDir);
			const systemPrompt = buildSystemPrompt({ cwd, ...resources });
			const createSession = async (sessionManager: SessionManager): Promise<AgentSession> => {
				const session = await context.require(agentSessionKey).create({
					allowedRoot: cwd,
					provider: runtime.provider,
					model: runtime.model,
					systemPrompt,
					skills: resources.skills,
					sessionManager,
					externalTools,
				});
				if (!(session instanceof AgentSession))
					throw new Error("SessionFactory returned an incompatible interactive session.");
				return session;
			};
			const session = await createSession(manager);
			const directory = sessionDirectory(agentDir, cwd);
			const sessionChoices: readonly InteractiveSessionChoice[] = [
				{
					id: "new-session",
					label: translate(configuration.locale ?? DEFAULT_LOCALE, "newSession"),
					description: translate(configuration.locale ?? DEFAULT_LOCALE, "newSessionDescription"),
					open: async () =>
						await createSession(
							await SessionManager.create({ filePath: newSessionPath(directory), cwd, deferCreate: true }),
						),
				},
				...(await interactiveSessionChoices(directory, manager.filePath, async (filePath) =>
					createSession(await SessionManager.open(filePath)),
				)),
			];
			let mode: import("./modes/interactive.ts").InteractiveMode | undefined;
			let theme = "dark";
			const interactiveContext: InteractiveContextService = {
				sessionChoices: () => sessionChoices,
				cancel: () => mode?.cancelActivePrompt(),
				retry: () => mode?.retryLastPrompt(),
				theme: () => theme,
				setTheme: (value) => {
					theme = value;
				},
				keybindings: () => context.get(keybindingRegistryKey)?.snapshot(),
			};
			const code = await context.require(modeRegistryKey).execute(
				"interactive",
				{
					run: () =>
						(options.startInteractiveMode ?? runInteractiveMode)({
							session,
							agentDir,
							locale: configuration.locale ?? DEFAULT_LOCALE,
							commandRegistry: context.require(commandRegistryKey),
							context: interactiveContext,
							initialPrompt: command.prompt,
							onCreated: (created) => {
								mode = created;
							},
							onExit: () => {
								void close();
							},
						}),
				},
				context.signal,
			);
			return code;
		} catch (cause) {
			await close();
			options.stderr(`${errorMessage(cause)}\n`);
			return 1;
		}
	} catch (cause) {
		options.stderr(`${errorMessage(cause)}\n`);
		return 1;
	}
}
