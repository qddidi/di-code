export type OutputMode = "print" | "json";

export type CliCommand = { kind: "help" } | { kind: "version" } | { kind: "run"; mode: OutputMode; prompt: string };

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
	const promptParts: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "-p" || argument === "--print") {
			printAlias = true;
			continue;
		}
		if (argument === "--mode") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new CliUsageError("Option --mode requires a value.");
			}
			if (value !== "print" && value !== "json") {
				throw new CliUsageError(`Unsupported mode "${value}". Expected print or json.`);
			}
			mode = value;
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

	if (printAlias && mode === "json") {
		throw new CliUsageError("Cannot combine --print with --mode json.");
	}
	if (promptParts.length === 0) {
		throw new CliUsageError("A prompt is required.");
	}

	return { kind: "run", mode, prompt: promptParts.join(" ") };
}

const HELP_TEXT = `Usage: di-code [options] <prompt>

Options:
  -p, --print        Print only the final assistant text (default)
  --mode <mode>      Output mode: print or json
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
