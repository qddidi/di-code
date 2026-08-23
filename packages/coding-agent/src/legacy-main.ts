import { randomUUID } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Model, Provider } from "@di-code/ai";
import { createBuiltinCommandRegistry, createModeRegistry, createRendererRegistry } from "@di-code/builtins";
import type { McpServerConnectionStatus } from "@di-code/mcp";
import { truncateToWidth } from "@di-code/tui";
import { type CliCommand, type CliDependencies, createCliParser, runCli } from "./cli.ts";
import { loadImageInputs } from "./core/image-input.ts";
import { loadResources } from "./core/resources/loader.ts";
import { SessionManager } from "./core/session/session-manager.ts";
import { AgentSession } from "./core/session.ts";
import { buildSystemPrompt } from "./core/system-prompt.ts";
import { workspaceStorageKey } from "./core/user-data.ts";
import { ProjectTrustManager } from "./extensions/trust.ts";
import { DEFAULT_LOCALE, type Locale, translate } from "./i18n.ts";
import { addMcpConfig, getMcpConfig, listMcpConfig, type McpConfigScope, removeMcpConfig } from "./mcp/config.ts";
import { loadProjectMcp } from "./mcp/loader.ts";
import { runInteractiveMode } from "./modes/interactive-entry.ts";
import { runJsonModeEntry } from "./modes/json-entry.ts";
import type { PrintIo } from "./modes/print.ts";
import { runPrintModeEntry } from "./modes/print-entry.ts";
import { loadPlugins, type PluginLoadStatus } from "./plugins/loader.ts";
import { PluginManager } from "./plugins/manager.ts";
import type { StartupConfiguration } from "./startup.ts";
import { resolveThinkingLevelPreference } from "./startup.ts";

export interface MainRuntime {
	readonly provider: Provider;
	readonly model: Model;
}

export interface MainOptions extends PrintIo {
	readonly version: string;
	readonly createRuntime: (
		command: Extract<CliCommand, { kind: "run" }>,
	) => MainRuntime | undefined | Promise<MainRuntime | undefined>;
	readonly allowedRoot?: string;
	readonly agentDir?: string;
	readonly startupConfiguration?: StartupConfiguration;
	/** Language for built-in human-facing CLI and terminal text. */
	readonly locale?: Locale;
	readonly now?: () => number;
	/** Whether stdin and stdout are interactive terminals. */
	readonly isInteractiveTerminal?: boolean;
	/** Ask whether project-local Skills, plugins, and extensions may be loaded. */
	readonly promptProjectTrust?: (cwd: string) => Promise<boolean>;
}

const MAX_SESSION_QUESTION_LENGTH = 72;

function defaultSessionDirectory(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", workspaceStorageKey(cwd));
}

const STARTUP_STATUS_COLORS = {
	error: "\x1b[31m",
	success: "\x1b[32m",
	warning: "\x1b[33m",
	reset: "\x1b[0m",
} as const;

function formatMcpStatus(status: McpServerConnectionStatus): string {
	switch (status.state) {
		case "connecting":
			return `${STARTUP_STATUS_COLORS.warning}MCP [loading]${STARTUP_STATUS_COLORS.reset} ${status.serverId}`;
		case "connected":
			return `${STARTUP_STATUS_COLORS.success}MCP [ok]${STARTUP_STATUS_COLORS.reset} ${status.serverId} (${status.tools} tools, ${status.resources} resources, ${status.prompts} prompts)`;
		case "failed":
			return `${STARTUP_STATUS_COLORS.error}MCP [error]${STARTUP_STATUS_COLORS.reset} ${status.serverId} (${status.stage}): ${status.message}`;
	}
}

function formatMcpDiagnostic(serverId: string | undefined, stage: string, message: string): string {
	return `${STARTUP_STATUS_COLORS.error}MCP [error]${STARTUP_STATUS_COLORS.reset} ${serverId ?? "configuration"} (${stage}): ${message}\n`;
}

function formatPluginStatus(status: PluginLoadStatus): string {
	switch (status.state) {
		case "loading":
			return `${STARTUP_STATUS_COLORS.warning}Plugin [loading]${STARTUP_STATUS_COLORS.reset} ${status.pluginId}`;
		case "loaded":
			return `${STARTUP_STATUS_COLORS.success}Plugin [ok]${STARTUP_STATUS_COLORS.reset} ${status.pluginId} (${status.tools} tools, ${status.commands} commands)`;
		case "failed":
			return `${STARTUP_STATUS_COLORS.error}Plugin [error]${STARTUP_STATUS_COLORS.reset} ${status.pluginId ?? "plugin"} (${status.stage}): ${status.message}`;
	}
}

function formatPluginDiagnostic(pluginId: string | undefined, stage: string, message: string): string {
	return `${STARTUP_STATUS_COLORS.error}Plugin [error]${STARTUP_STATUS_COLORS.reset} ${pluginId ?? "plugin"} (${stage}): ${message}\n`;
}

function pluginStatusKey(status: PluginLoadStatus): string {
	if (status.state === "failed" && status.pluginId === undefined) return `plugin:${status.sourcePath}`;
	return `plugin:${status.pluginId}`;
}

/** Renders startup states in place so terminal history retains only their final outcome. */
export class StartupStatusRenderer {
	private readonly lines: string[] = [];
	private readonly indexes = new Map<string, number>();
	private readonly write: (text: string) => void;
	private readonly replaceInPlace: boolean;
	private readonly width: number;

	constructor(write: (text: string) => void, replaceInPlace: boolean, width = 80) {
		this.write = write;
		this.replaceInPlace = replaceInPlace;
		this.width = width;
	}

	update(key: string, text: string): void {
		const line = truncateToWidth(text.replace(/[\r\n]+/g, " "), Math.max(1, this.width), "...");
		const index = this.indexes.get(key);
		if (index === undefined || !this.replaceInPlace) {
			this.indexes.set(key, this.lines.length);
			this.lines.push(line);
			this.write(`${line}\n`);
			return;
		}
		this.lines[index] = line;
		const offset = this.lines.length - index;
		this.write(`\x1b[${offset}A\r\x1b[2K${line}\x1b[${offset}B\r`);
	}
}

function startupStatusRenderer(write: (text: string) => void, interactive: boolean): StartupStatusRenderer {
	const width = typeof process.stderr.columns === "number" && process.stderr.columns > 0 ? process.stderr.columns : 80;
	return new StartupStatusRenderer(write, interactive && process.stderr.isTTY === true, width);
}

async function openOrCreateSession(filePath: string, cwd: string, now: () => number): Promise<SessionManager> {
	try {
		await access(filePath);
		return await SessionManager.open(filePath, { now });
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		return SessionManager.create({ filePath, cwd, now, deferCreate: true });
	}
}

function newSessionPath(sessionDirectory: string, now: () => number): string {
	return join(sessionDirectory, `session-${now()}-${randomUUID().slice(0, 8)}.jsonl`);
}

async function mostRecentSessionPath(sessionDirectory: string): Promise<string | undefined> {
	let names: string[];
	try {
		names = (await readdir(sessionDirectory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl")
			.map((entry) => entry.name);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		throw cause;
	}

	const candidates = await Promise.all(
		names.map(async (name) => {
			const filePath = join(sessionDirectory, name);
			try {
				return { filePath, modifiedAt: (await stat(filePath)).mtimeMs };
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
				throw cause;
			}
		}),
	);
	return candidates
		.filter((candidate): candidate is { filePath: string; modifiedAt: number } => candidate !== undefined)
		.sort((left, right) => right.modifiedAt - left.modifiedAt || right.filePath.localeCompare(left.filePath))[0]
		?.filePath;
}

async function hasProjectLocalCapabilities(cwd: string): Promise<boolean> {
	const directories = [
		join(cwd, ".di-code", "skills"),
		join(cwd, ".agents", "skills"),
		join(cwd, ".di-code", "extensions"),
		join(cwd, ".di-code", "plugins"),
		join(cwd, ".di-code", "mcp.local.json"),
		join(cwd, ".mcp.json"),
	];
	const results = await Promise.all(
		directories.map(async (directory) => {
			try {
				const metadata = await stat(directory);
				return metadata.isDirectory() || metadata.isFile();
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
				return false;
			}
		}),
	);
	return results.some(Boolean);
}

async function selectStartupSession(
	command: Extract<CliCommand, { kind: "run" }>,
	allowedRoot: string,
	agentDir: string,
	now: () => number,
): Promise<SessionManager> {
	const sessionDirectory = defaultSessionDirectory(agentDir, allowedRoot);
	if (command.sessionPath !== undefined) {
		return openOrCreateSession(resolve(allowedRoot, command.sessionPath), allowedRoot, now);
	}
	if (command.continueSession) {
		const recentPath = await mostRecentSessionPath(sessionDirectory);
		if (recentPath !== undefined) return SessionManager.open(recentPath, { now });
	}
	return SessionManager.create({
		filePath: newSessionPath(sessionDirectory, now),
		cwd: allowedRoot,
		now,
		deferCreate: true,
	});
}

function formatSessionTimestamp(timestamp: number, fallback: string, timeZone?: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return fallback;
	try {
		const parts = new Map(
			new Intl.DateTimeFormat("en-CA", {
				timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			})
				.formatToParts(date)
				.filter((part) => part.type !== "literal")
				.map((part) => [part.type, part.value]),
		);
		const year = parts.get("year");
		const month = parts.get("month");
		const day = parts.get("day");
		const hour = parts.get("hour");
		const minute = parts.get("minute");
		if (!year || !month || !day || !hour || !minute) return fallback;
		return `${year}-${month}-${day} ${hour}:${minute}`;
	} catch {
		return fallback;
	}
}

export function formatSessionLabel(manager: SessionManager, timeZone?: string): string {
	const firstUserEntry = manager.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	const fileName = basename(manager.filePath, extname(manager.filePath));
	if (firstUserEntry?.type !== "message" || firstUserEntry.message.role !== "user") {
		return `${fileName} (${formatSessionTimestamp(Date.parse(manager.header.timestamp), manager.header.timestamp, timeZone)})`;
	}

	const question = firstUserEntry.message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	const label =
		question.length > MAX_SESSION_QUESTION_LENGTH
			? `${question.slice(0, MAX_SESSION_QUESTION_LENGTH - 3)}...`
			: question || fileName;
	const timestamp = formatSessionTimestamp(firstUserEntry.message.timestamp, firstUserEntry.timestamp, timeZone);
	return `${label} (${timestamp})`;
}

async function sessionChoices(
	sessionDirectory: string,
	currentFile: string,
	open: (filePath: string) => Promise<AgentSession>,
): Promise<readonly { id: string; label: string; description: string; open: () => Promise<AgentSession> }[]> {
	let names: string[] = [];
	try {
		names = (await readdir(sessionDirectory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl")
			.map((entry) => entry.name)
			.sort();
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
	}

	return Promise.all(
		names
			.filter((name) => resolve(sessionDirectory, name) !== resolve(currentFile))
			.map(async (name) => {
				const filePath = join(sessionDirectory, name);
				const id = basename(name, extname(name));
				let label = id;
				try {
					label = formatSessionLabel(await SessionManager.open(filePath));
				} catch {
					// Keep damaged sessions selectable so opening one can report the detailed load error.
				}
				return {
					id,
					label,
					description: filePath,
					open: () => open(filePath),
				};
			}),
	);
}

export async function runMain(args: readonly string[], options: MainOptions): Promise<number> {
	const dependencies: CliDependencies = {
		stdout: options.stdout,
		stderr: options.stderr,
		version: options.version,
		locale: options.locale ?? options.startupConfiguration?.locale ?? DEFAULT_LOCALE,
		parser: createCliParser(),
		plugin: async (command) => {
			const agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
			const manager = new PluginManager({ agentDir });
			try {
				switch (command.action) {
					case "list":
						for (const plugin of await manager.list())
							options.stdout(`${plugin.id}\t${plugin.enabled ? "enabled" : "disabled"}\t${plugin.manifest.version}\n`);
						return 0;
					case "install": {
						const plugin = await manager.install(command.argument as string);
						options.stdout(`Installed ${plugin.id}\n`);
						return 0;
					}
					case "enable":
						await manager.enable(command.argument as string);
						return 0;
					case "disable":
						await manager.disable(command.argument as string);
						return 0;
					case "update":
						await manager.update(command.argument as string);
						return 0;
					case "remove":
						await manager.remove(command.argument as string);
						return 0;
				}
			} catch (cause) {
				options.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
				return 1;
			}
		},
		mcp: async (command) => {
			const cwd = resolve(options.allowedRoot ?? process.cwd());
			const scope = command.scope;
			const trustManager = new ProjectTrustManager(join(options.agentDir ?? join(homedir(), ".di-code"), "trust.json"));
			const requireProjectTrust = async (selected: McpConfigScope): Promise<void> => {
				if ((selected === "local" || selected === "project") && (await trustManager.get(cwd)) !== true)
					throw new Error(`Project trust is required to modify the ${selected} MCP scope.`);
			};
			try {
				switch (command.action) {
					case "add": {
						const selected = scope ?? "local";
						await requireProjectTrust(selected);
						const config =
							command.transport === "stdio"
								? {
										command: command.command,
										...(command.args && command.args.length > 0 ? { args: command.args } : {}),
									}
								: { type: "http", url: command.url };
						await addMcpConfig(cwd, selected, command.serverId as string, config);
						options.stdout(`Added MCP server "${command.serverId}" to ${selected} scope.\n`);
						return 0;
					}
					case "list": {
						const scopes: readonly McpConfigScope[] = scope ? [scope] : ["local", "project", "user"];
						for (const selected of scopes) {
							for (const entry of await listMcpConfig(cwd, selected))
								options.stdout(`${entry.id}\t${entry.scope}\t${JSON.stringify(entry.config)}\n`);
						}
						return 0;
					}
					case "get": {
						const entry = await getMcpConfig(cwd, command.serverId as string, scope);
						if (!entry) throw new Error(`MCP server "${command.serverId}" was not found.`);
						options.stdout(`${JSON.stringify({ id: entry.id, scope: entry.scope, config: entry.config })}\n`);
						return 0;
					}
					case "remove": {
						const selected = scope ?? "local";
						await requireProjectTrust(selected);
						await removeMcpConfig(cwd, selected, command.serverId as string);
						options.stdout(`Removed MCP server "${command.serverId}" from ${selected} scope.\n`);
						return 0;
					}
				}
			} catch (cause) {
				options.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
				return 1;
			}
		},
		run: async (command) => {
			const allowedRoot = resolve(options.allowedRoot ?? process.cwd());
			const now = options.now ?? Date.now;
			const agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
			const trustManager = new ProjectTrustManager(join(agentDir, "trust.json"));
			if (command.projectTrust !== undefined) await trustManager.set(allowedRoot, command.projectTrust);
			let persistedTrust = await trustManager.get(allowedRoot);
			const shouldPromptForTrust =
				command.mode === "interactive" &&
				options.isInteractiveTerminal === true &&
				command.projectTrust === undefined &&
				persistedTrust === null &&
				options.promptProjectTrust !== undefined &&
				(await hasProjectLocalCapabilities(allowedRoot));
			if (shouldPromptForTrust) {
				let decision = false;
				try {
					decision = await options.promptProjectTrust(allowedRoot);
				} catch {
					// Fail closed when the prompt is interrupted or unavailable.
				}
				await trustManager.set(allowedRoot, decision);
				persistedTrust = decision;
			}
			const runtime = await options.createRuntime(command);
			if (runtime === undefined) return 0;
			const resources = await loadResources({
				cwd: allowedRoot,
				agentDir,
				projectTrusted: persistedTrust === true,
				noSkills: command.noSkills,
				noContextFiles: command.noContextFiles,
				skillPaths: command.skillPaths,
			});
			for (const diagnostic of resources.diagnostics) {
				if (diagnostic.kind !== "skill") continue;
				options.stderr(
					`${JSON.stringify({ type: "skill_diagnostic", path: diagnostic.path, stage: diagnostic.stage, severity: diagnostic.severity, message: diagnostic.message })}\n`,
				);
			}
			const interactivePluginStatus = command.mode === "interactive";
			const startupStatus = startupStatusRenderer(options.stderr, interactivePluginStatus);
			const pluginStatusFailures = new Set<string>();
			const extensions = await loadPlugins({
				cwd: allowedRoot,
				agentDir,
				trustManager,
				mode: command.mode,
				...(interactivePluginStatus
					? {
							onPluginLoadStatus: (status) => {
								if (status.state === "failed") pluginStatusFailures.add(status.sourcePath);
								startupStatus.update(pluginStatusKey(status), formatPluginStatus(status));
							},
						}
					: {}),
			});
			for (const diagnostic of extensions.diagnostics) {
				if (interactivePluginStatus) {
					if (pluginStatusFailures.has(diagnostic.sourcePath)) continue;
					options.stderr(formatPluginDiagnostic(diagnostic.pluginId, diagnostic.stage, diagnostic.message));
					continue;
				}
				options.stderr(
					`${JSON.stringify({ type: "plugin_diagnostic", pluginId: diagnostic.pluginId, stage: diagnostic.stage, sourcePath: diagnostic.sourcePath, severity: diagnostic.severity, message: diagnostic.message })}\n`,
				);
			}
			const interactiveMcpStatus = command.mode === "interactive";
			const mcp = await loadProjectMcp({
				cwd: allowedRoot,
				projectTrusted: persistedTrust === true,
				homeDirectory: homedir(),
				reservedToolNames: [
					"read",
					"write",
					"edit",
					"bash",
					"load_skill",
					...extensions.host.listTools().map((tool) => tool.name),
				],
				...(interactiveMcpStatus
					? {
							onServerConnectionStatus: (status) =>
								startupStatus.update(`mcp:${status.serverId}`, formatMcpStatus(status)),
						}
					: {}),
			});
			for (const diagnostic of mcp.diagnostics) {
				if (interactiveMcpStatus) {
					if (diagnostic.serverId && (diagnostic.stage === "connect" || diagnostic.stage === "list_tools")) continue;
					options.stderr(formatMcpDiagnostic(diagnostic.serverId, diagnostic.stage, diagnostic.message));
					continue;
				}
				options.stderr(
					`${JSON.stringify({ type: "mcp_diagnostic", serverId: diagnostic.serverId, stage: diagnostic.stage, message: diagnostic.message })}\n`,
				);
			}
			const systemPrompt = buildSystemPrompt({ cwd: allowedRoot, ...resources });
			const manager = await selectStartupSession(command, allowedRoot, agentDir, now);
			const sessionFile = manager.filePath;
			const thinkingLevel = resolveThinkingLevelPreference(options.startupConfiguration, runtime);
			const session = new AgentSession({
				allowedRoot,
				provider: runtime.provider,
				model: runtime.model,
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				systemPrompt,
				skills: resources.skills,
				now: options.now,
				sessionManager: manager,
				extensionHost: extensions.host,
				externalTools: mcp.tools,
			});
			const imagePaths = command.imagePaths ?? [];
			const promptRunner = {
				prompt: async (text: string) => session.promptWithImages(text, await loadImageInputs(imagePaths, allowedRoot)),
				subscribe: session.subscribe.bind(session),
			};
			const modes = createModeRegistry();
			const renderers = createRendererRegistry();
			renderers.register({ name: "json", render: (event) => JSON.stringify({ version: 2, event }) });
			const commandRegistry = (() => {
				const registry = createBuiltinCommandRegistry();
				for (const command of extensions.host.listCommands()) {
					if (registry.list().some((entry) => entry.name === command.name)) continue;
					registry.register({
						name: command.name,
						description: command.description,
						run: (input) => {
							const args =
								typeof input === "object" && input !== null && "args" in input && typeof input.args === "string"
									? input.args
									: "";
							return extensions.host.runCommand(command.name, args).then(() => 0);
						},
					});
				}
				return registry;
			})();
			const sessions = [
				{
					id: "new-session",
					label: translate(options.locale ?? options.startupConfiguration?.locale ?? DEFAULT_LOCALE, "newSession"),
					description: translate(
						options.locale ?? options.startupConfiguration?.locale ?? DEFAULT_LOCALE,
						"newSessionDescription",
					),
					open: async () => {
						const filePath = newSessionPath(dirname(sessionFile), now);
						const nextManager = await SessionManager.create({ filePath, cwd: allowedRoot, now, deferCreate: true });
						return new AgentSession({
							allowedRoot,
							provider: runtime.provider,
							model: runtime.model,
							...(thinkingLevel === undefined ? {} : { thinkingLevel }),
							systemPrompt,
							skills: resources.skills,
							now: options.now,
							sessionManager: nextManager,
							extensionHost: extensions.host,
							externalTools: mcp.tools,
						});
					},
				},
				...(await sessionChoices(dirname(sessionFile), sessionFile, async (filePath) => {
					const nextManager = await SessionManager.open(filePath, { now });
					return new AgentSession({
						allowedRoot,
						provider: runtime.provider,
						model: runtime.model,
						...(thinkingLevel === undefined ? {} : { thinkingLevel }),
						systemPrompt,
						skills: resources.skills,
						now: options.now,
						sessionManager: nextManager,
						extensionHost: extensions.host,
						externalTools: mcp.tools,
					});
				})),
			];
			let interactiveMode: import("./modes/interactive.ts").InteractiveMode | undefined;
			const interactiveContext = {
				sessionChoices: () => sessions,
				cancel: () => interactiveMode?.cancelActivePrompt(),
				retry: () => interactiveMode?.retryLastPrompt(),
				theme: () => "dark",
				setTheme: (_value: string) => undefined,
				keybindings: () => undefined,
			};
			modes.register({
				name: "json",
				run: async () => {
					await extensions.host.emit({ type: "session_start", cwd: allowedRoot });
					try {
						return await runJsonModeEntry({
							prompt: command.prompt,
							runner: promptRunner,
							io: options,
							renderer: renderers.find("json"),
							onStart: () => undefined,
							onStop: () => undefined,
						});
					} finally {
						await extensions.host.emit({ type: "session_shutdown", reason: "user" });
						await mcp.manager.close();
					}
				},
			});
			modes.register({
				name: "interactive",
				run: async () => {
					const result = runInteractiveMode({
						session,
						agentDir,
						locale: options.locale ?? options.startupConfiguration?.locale ?? DEFAULT_LOCALE,
						commandRegistry,
						context: interactiveContext,
						onCreated: (mode) => {
							interactiveMode = mode;
						},
						onExit: () => void mcp.manager.close(),
						extensionHost: extensions.host,
						...(options.startupConfiguration
							? { providerOnboarding: { configuration: options.startupConfiguration, agentDir } }
							: {}),
						initialPrompt: command.prompt,
					});
					return result;
				},
			});
			modes.register({
				name: "print",
				run: async () => {
					await extensions.host.emit({ type: "session_start", cwd: allowedRoot });
					try {
						return await runPrintModeEntry({
							prompt: command.prompt,
							runner: promptRunner,
							io: options,
							onStart: () => undefined,
							onStop: () => undefined,
						});
					} finally {
						await extensions.host.emit({ type: "session_shutdown", reason: "user" });
						await mcp.manager.close();
					}
				},
			});
			return modes.execute(command.mode, {});
		},
	};

	return runCli(args, dependencies);
}
