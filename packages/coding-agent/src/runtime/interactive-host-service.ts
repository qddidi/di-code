import type { CliCommand } from "../cli.ts";
import type { InteractiveModeEntryOptions } from "../modes/interactive-entry.ts";

export interface InteractiveBootstrapOptions {
	readonly isInteractiveTerminal: boolean;
	readonly promptProjectTrust?: (cwd: string) => Promise<boolean>;
	readonly startInteractiveMode?: (options: InteractiveModeEntryOptions) => number;
}

export type InteractiveCliCommand = Extract<CliCommand, { kind: "run" }> & { readonly mode: "interactive" };

/** Input supplied by bootstrap to the composition-owned interactive host command. */
export interface InteractiveHostRequest {
	readonly command: InteractiveCliCommand;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
	readonly stderr: (text: string) => void;
	readonly startInteractiveMode?: (options: InteractiveModeEntryOptions) => number;
}
