import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { type CliDependencies, runCli } from "./cli.ts";
import { AgentSession } from "./core/session.ts";
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
			return runPrintMode(command.prompt, session, options);
		},
	};

	return runCli(args, dependencies);
}
