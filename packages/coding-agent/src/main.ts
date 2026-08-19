import { randomUUID } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Model, Provider } from "@di-code/ai";
import { ProcessTerminal, TUI } from "@di-code/tui";
import { type CliCommand, type CliDependencies, runCli } from "./cli.ts";
import { loadImageInputs } from "./core/image-input.ts";
import { loadResources } from "./core/resources/loader.ts";
import { SessionManager } from "./core/session/session-manager.ts";
import { AgentSession } from "./core/session.ts";
import { buildSystemPrompt } from "./core/system-prompt.ts";
import { ProjectTrustManager } from "./extensions/trust.ts";
import { addMcpConfig, getMcpConfig, listMcpConfig, type McpConfigScope, removeMcpConfig } from "./mcp/config.ts";
import { loadProjectMcp } from "./mcp/loader.ts";
import { InteractiveMode } from "./modes/interactive.ts";
import { runJsonMode } from "./modes/json.ts";
import { type PrintIo, runPrintMode } from "./modes/print.ts";
import { loadPlugins } from "./plugins/loader.ts";
import { PluginManager } from "./plugins/manager.ts";
import type { StartupConfiguration } from "./startup.ts";

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
	readonly now?: () => number;
	/** Whether stdin and stdout are interactive terminals. */
	readonly isInteractiveTerminal?: boolean;
	/** Ask whether project-local Skills, plugins, and extensions may be loaded. */
	readonly promptProjectTrust?: (cwd: string) => Promise<boolean>;
}

const DEFAULT_SESSION_DIRECTORY = join(".di-code", "sessions");
const MAX_SESSION_QUESTION_LENGTH = 72;

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
	now: () => number,
): Promise<SessionManager> {
	const sessionDirectory = resolve(allowedRoot, DEFAULT_SESSION_DIRECTORY);
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
			const extensions = await loadPlugins({
				cwd: allowedRoot,
				agentDir,
				trustManager,
				mode: command.mode,
			});
			for (const diagnostic of extensions.diagnostics) {
				options.stderr(
					`${JSON.stringify({ type: "plugin_diagnostic", pluginId: diagnostic.pluginId, stage: diagnostic.stage, sourcePath: diagnostic.sourcePath, severity: diagnostic.severity, message: diagnostic.message })}\n`,
				);
			}
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
			});
			for (const diagnostic of mcp.diagnostics) {
				options.stderr(
					`${JSON.stringify({ type: "mcp_diagnostic", serverId: diagnostic.serverId, stage: diagnostic.stage, message: diagnostic.message })}\n`,
				);
			}
			const systemPrompt = buildSystemPrompt({ cwd: allowedRoot, ...resources });
			const manager = await selectStartupSession(command, allowedRoot, now);
			const sessionFile = manager.filePath;
			const session = new AgentSession({
				allowedRoot,
				provider: runtime.provider,
				model: runtime.model,
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
			if (command.mode === "json") {
				await extensions.host.emit({ type: "session_start", cwd: allowedRoot });
				try {
					return await runJsonMode(command.prompt, promptRunner, options);
				} finally {
					await extensions.host.emit({ type: "session_shutdown", reason: "user" });
					await mcp.manager.close();
				}
			}
			if (command.mode === "interactive") {
				const terminal = new ProcessTerminal();
				const tui = new TUI(terminal);
				const mode = new InteractiveMode({
					session,
					tui,
					onExit: () => {
						void mcp.manager.close();
					},
					extensionHost: extensions.host,
					...(options.startupConfiguration
						? { providerOnboarding: { configuration: options.startupConfiguration, agentDir } }
						: {}),
					sessions: [
						{
							id: "new-session",
							label: "New session",
							description: "Start a new persistent conversation.",
							open: async () => {
								const filePath = newSessionPath(dirname(sessionFile), now);
								const nextManager = await SessionManager.create({
									filePath,
									cwd: allowedRoot,
									now,
									deferCreate: true,
								});
								return new AgentSession({
									allowedRoot,
									provider: runtime.provider,
									model: runtime.model,
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
								systemPrompt,
								skills: resources.skills,
								now: options.now,
								sessionManager: nextManager,
								extensionHost: extensions.host,
								externalTools: mcp.tools,
							});
						})),
					],
				});
				mode.start(command.prompt);
				return 0;
			}
			await extensions.host.emit({ type: "session_start", cwd: allowedRoot });
			try {
				return await runPrintMode(command.prompt, promptRunner, options);
			} finally {
				await extensions.host.emit({ type: "session_shutdown", reason: "user" });
				await mcp.manager.close();
			}
		},
	};

	return runCli(args, dependencies);
}
