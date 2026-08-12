import { Agent } from "@di-code/agent";
import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { type CliDependencies, runCli } from "./cli.ts";
import { runJsonMode } from "./modes/json.ts";
import { type PrintIo, runPrintMode } from "./modes/print.ts";

export interface MainOptions extends PrintIo {
	readonly version: string;
	readonly fauxResponses: readonly FauxResponse[];
	readonly now?: () => number;
}

export async function runMain(args: readonly string[], options: MainOptions): Promise<number> {
	const dependencies: CliDependencies = {
		stdout: options.stdout,
		stderr: options.stderr,
		version: options.version,
		run: async (command) => {
			const faux = createFauxProvider({ responses: options.fauxResponses, now: options.now });
			const agent = new Agent({ provider: faux.provider, model: faux.model, now: options.now });
			if (command.mode === "json") {
				return runJsonMode(command.prompt, agent, options);
			}
			return runPrintMode(command.prompt, agent, options);
		},
	};

	return runCli(args, dependencies);
}
