export type OutputMode = "print" | "json" | "interactive";

export type CliCommand =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "plugin"; action: "install" | "list" | "enable" | "disable" | "update" | "remove"; argument?: string }
	| {
			kind: "run";
			mode: OutputMode;
			prompt: string;
			sessionPath?: string;
			continueSession?: true;
			imagePaths?: readonly string[];
			noSkills?: true;
			noContextFiles?: true;
			skillPaths?: readonly string[];
			projectTrust?: boolean;
	  };

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export function parseCliArgs(args: readonly string[]): CliCommand {
	if (args[0] === "plugin") {
		const action = args[1];
		if (
			action !== "install" &&
			action !== "list" &&
			action !== "enable" &&
			action !== "disable" &&
			action !== "update" &&
			action !== "remove"
		)
			throw new CliUsageError("Plugin command must be install, list, enable, disable, update, or remove.");
		const argument = args[2];
		if (
			args.length > 3 ||
			(action !== "list" && (argument === undefined || argument.trim() === "")) ||
			(action === "list" && argument !== undefined)
		)
			throw new CliUsageError("Plugin command has invalid arguments.");
		return { kind: "plugin", action, ...(argument ? { argument } : {}) };
	}
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
	let noSkills = false;
	let noContextFiles = false;
	let projectTrust: boolean | undefined;
	const skillPaths: string[] = [];
	const imagePaths: string[] = [];
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
		if (argument === "--no-skills") {
			noSkills = true;
			continue;
		}
		if (argument === "--no-context-files") {
			noContextFiles = true;
			continue;
		}
		if (argument === "--trust-project" || argument === "--untrust-project") {
			const nextTrust = argument === "--trust-project";
			if (projectTrust !== undefined && projectTrust !== nextTrust) {
				throw new CliUsageError("Cannot combine --trust-project with --untrust-project.");
			}
			projectTrust = nextTrust;
			continue;
		}
		if (argument === "--skill") {
			const value = args[index + 1];
			if (value === undefined || value.trim().length === 0) {
				throw new CliUsageError("Option --skill requires a non-empty value.");
			}
			skillPaths.push(value);
			index++;
			continue;
		}
		if (argument === "--image") {
			const value = args[index + 1];
			if (value === undefined || value.trim().length === 0) {
				throw new CliUsageError("Option --image requires a non-empty value.");
			}
			imagePaths.push(value);
			index++;
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
	if (mode === "interactive" && imagePaths.length > 0) {
		throw new CliUsageError("--image is not available in interactive mode.");
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
		...(noSkills ? { noSkills: true as const } : {}),
		...(noContextFiles ? { noContextFiles: true as const } : {}),
		...(skillPaths.length > 0 ? { skillPaths } : {}),
		...(imagePaths.length > 0 ? { imagePaths } : {}),
		...(projectTrust === undefined ? {} : { projectTrust }),
	};
}

const HELP_TEXT = `Usage: di-code [options] <prompt>

Options:
  -p, --print        Print only the final assistant text (default)
  --mode <mode>      Output mode: print, json, or interactive
  --interactive      Start interactive terminal mode
  --continue, -c     Continue the most recently modified session
  --session <path>   Create or resume a JSONL session (relative to the work root)
  --image <path>     Attach a local PNG, JPEG, WebP, or GIF image (repeatable)
  --skill <path>     Add a SKILL.md file or skill directory (repeatable)
  --no-skills        Disable all Skill loading
  --no-context-files Disable AGENTS.md discovery and loading
  --trust-project    Persist trust for project-local Skill discovery
  --untrust-project  Persist denial for project-local Skill discovery
  plugin <action>    Install, list, enable, disable, update, or remove a plugin
  -h, --help         Show help
  -v, --version      Show version
`;

export interface CliDependencies {
	stdout(text: string): void;
	stderr(text: string): void;
	run(command: Extract<CliCommand, { kind: "run" }>): Promise<number>;
	plugin?(command: Extract<CliCommand, { kind: "plugin" }>): Promise<number>;
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
		case "plugin":
			if (!dependencies.plugin) throw new Error("Plugin command handler is unavailable.");
			return dependencies.plugin(command);
		case "version":
			dependencies.stdout(`${dependencies.version}\n`);
			return 0;
		case "run":
			return dependencies.run(command);
	}
}
