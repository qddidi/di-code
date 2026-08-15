import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Model, Provider } from "@di-code/ai";
import { ProcessTerminal, TUI } from "@di-code/tui";
import { type CliDependencies, runCli } from "./cli.ts";
import { SessionManager } from "./core/session/session-manager.ts";
import { AgentSession } from "./core/session.ts";
import { InteractiveMode } from "./modes/interactive.ts";
import { runJsonMode } from "./modes/json.ts";
import { type PrintIo, runPrintMode } from "./modes/print.ts";

export interface MainRuntime {
	readonly provider: Provider;
	readonly model: Model;
}

export interface MainOptions extends PrintIo {
	readonly version: string;
	readonly createRuntime: () => MainRuntime;
	readonly allowedRoot?: string;
	readonly now?: () => number;
}

const DEFAULT_SESSION_PATH = join(".di-code", "sessions", "default.jsonl");

async function openOrCreateSession(filePath: string, cwd: string): Promise<SessionManager> {
	try {
		await access(filePath);
		return await SessionManager.open(filePath);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		return SessionManager.create({ filePath, cwd });
	}
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

	return names
		.filter((name) => resolve(sessionDirectory, name) !== resolve(currentFile))
		.map((name) => {
			const filePath = join(sessionDirectory, name);
			const id = basename(name, extname(name));
			return {
				id,
				label: id,
				description: filePath,
				open: () => open(filePath),
			};
		});
}

export async function runMain(args: readonly string[], options: MainOptions): Promise<number> {
	const dependencies: CliDependencies = {
		stdout: options.stdout,
		stderr: options.stderr,
		version: options.version,
		run: async (command) => {
			const allowedRoot = resolve(options.allowedRoot ?? process.cwd());
			const sessionFile = resolve(allowedRoot, command.sessionPath ?? DEFAULT_SESSION_PATH);
			const manager = await openOrCreateSession(sessionFile, allowedRoot);
			const runtime = options.createRuntime();
			const session = new AgentSession({
				allowedRoot,
				provider: runtime.provider,
				model: runtime.model,
				now: options.now,
				sessionManager: manager,
			});
			if (command.mode === "json") {
				return runJsonMode(command.prompt, session, options);
			}
			if (command.mode === "interactive") {
				const terminal = new ProcessTerminal();
				const tui = new TUI(terminal);
				const mode = new InteractiveMode({
					session,
					tui,
					sessions: [
						{
							id: "new-session",
							label: "New session",
							description: "Start a new persistent conversation.",
							open: async () => {
								const filePath = join(dirname(sessionFile), `session-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`);
								const nextManager = await SessionManager.create({ filePath, cwd: allowedRoot });
								return new AgentSession({
									allowedRoot,
									provider: runtime.provider,
									model: runtime.model,
									now: options.now,
									sessionManager: nextManager,
								});
							},
						},
						...(await sessionChoices(dirname(sessionFile), sessionFile, async (filePath) => {
							const nextManager = await SessionManager.open(filePath);
							return new AgentSession({
								allowedRoot,
								provider: runtime.provider,
								model: runtime.model,
								now: options.now,
								sessionManager: nextManager,
							});
						})),
					],
				});
				mode.start(command.prompt);
				return 0;
			}
			return runPrintMode(command.prompt, session, options);
		},
	};

	return runCli(args, dependencies);
}
