import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { ProcessTerminal, TUI } from "@di-code/tui";
import { type CliDependencies, runCli } from "./cli.ts";
import { AgentSession } from "./core/session.ts";
import { InteractiveMode } from "./modes/interactive.ts";
import { runJsonMode } from "./modes/json.ts";
import { type PrintIo, runPrintMode } from "./modes/print.ts";

export interface MainOptions extends PrintIo {
	readonly version: string;
	readonly fauxResponses: readonly FauxResponse[];
	readonly allowedRoot?: string;
	readonly now?: () => number;
}

export async function runMain(args: readonly string[], options: MainOptions): Promise<number> {
	const dependencies: CliDependencies = {
		stdout: options.stdout,
		stderr: options.stderr,
		version: options.version,
		run: async (command) => {
			const faux = createFauxProvider({ responses: options.fauxResponses, now: options.now });
			const session = new AgentSession({
				allowedRoot: options.allowedRoot ?? process.cwd(),
				provider: faux.provider,
				model: faux.model,
				now: options.now,
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
							description: "Start a new in-memory conversation.",
							open: () =>
								new AgentSession({
									allowedRoot: options.allowedRoot ?? process.cwd(),
									provider: faux.provider,
									model: faux.model,
									now: options.now,
								}),
						},
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
