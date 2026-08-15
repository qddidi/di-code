export type OutputMode = "print" | "json" | "interactive";

export type CliCommand =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "run"; mode: OutputMode; prompt: string; sessionPath?: string; continueSession?: true };

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export function parseCliArgs(args: readonly string[]): CliCommand {
	const staticOption = args.find((argument) => ["-h", "--help", "-v", "--version"].includes(argument));
	if (staticOption !== undefined) {
		const kind = staticOption === "-h" || staticOption === "--help" ? "help" : "version";
		if (args.length !== 1) {
			throw new CliUsageError(`--${kind} must be used on its own.`);
		}
		return { kind };
	}

	let mode: OutputMode = "print";
	let printAlias = false;
	let sessionPath: string | undefined;
	let continueSession = false;
	const promptParts: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "-p" || argument === "--print") {
			printAlias = true;
			continue;
		}
		if (argument === "--interactive") {
			mode = "interactive";
			continue;
		}
		if (argument === "-c" || argument === "--continue") {
			continueSession = true;
			continue;
		}
		if (argument === "--mode") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new CliUsageError("Option --mode requires a value.");
			}
			if (value !== "print" && value !== "json" && value !== "interactive") {
				throw new CliUsageError(`Unsupported mode "${value}". Expected print, json, or interactive.`);
			}
			mode = value;
			index++;
			continue;
		}
		if (argument === "--session") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new CliUsageError("Option --session requires a value.");
			}
			if (value.trim().length === 0) {
				throw new CliUsageError("Option --session requires a non-empty value.");
			}
			sessionPath = value;
			index++;
			continue;
		}
		if (argument?.startsWith("-")) {
			throw new CliUsageError(`Unknown option "${argument}".`);
		}
		if (argument !== undefined) {
			promptParts.push(argument);
		}
	}

	if (printAlias && mode !== "print") {
		throw new CliUsageError(`Cannot combine --print with --mode ${mode}.`);
	}
	if (continueSession && sessionPath !== undefined) {
		throw new CliUsageError("Cannot combine --continue with --session.");
	}
	if (promptParts.length === 0 && mode !== "interactive") {
		throw new CliUsageError("A prompt is required.");
	}

	return {
		kind: "run",
		mode,
		prompt: promptParts.join(" "),
		...(sessionPath ? { sessionPath } : {}),
		...(continueSession ? { continueSession: true as const } : {}),
	};
}

const HELP_TEXT = `Usage: di-code [options] <prompt>

Options:
  -p, --print        Print only the final assistant text (default)
  --mode <mode>      Output mode: print, json, or interactive
  --interactive      Start interactive terminal mode
  --continue, -c     Continue the most recently modified session
  --session <path>   Create or resume a JSONL session (relative to the work root)
  -h, --help         Show help
  -v, --version      Show version
`;

export interface CliDependencies {
	stdout(text: string): void;
	stderr(text: string): void;
	run(command: Extract<CliCommand, { kind: "run" }>): Promise<number>;
	readonly version: string;
}

export async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
	let command: CliCommand;
	try {
		command = parseCliArgs(args);
	} catch (cause) {
		if (cause instanceof CliUsageError) {
			dependencies.stderr(`${cause.message}\n`);
			return 1;
		}
		throw cause;
	}

	switch (command.kind) {
		case "help":
			dependencies.stdout(HELP_TEXT);
			return 0;
		case "version":
			dependencies.stdout(`${dependencies.version}\n`);
			return 0;
		case "run":
			return dependencies.run(command);
	}
}
