import { DEFAULT_LOCALE, type Locale, translate } from "./i18n.ts";

export type OutputMode = "print" | "json" | "interactive";

export type CliCommand =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "plugin"; action: "install" | "list" | "enable" | "disable" | "update" | "remove"; argument?: string }
	| {
			kind: "mcp";
			action: "add" | "list" | "get" | "remove";
			scope?: "local" | "project" | "user";
			serverId?: string;
			transport?: "stdio" | "http";
			command?: string;
			args?: readonly string[];
			url?: string;
	  }
	| {
			kind: "run";
			mode: OutputMode;
			prompt: string;
			sessionPath?: string;
			continueSession?: true;
			imagePaths?: readonly string[];
			profile?: string;
			ui?: string;
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
	if (args[0] === "mcp") return parseMcpArgs(args.slice(1));
	const staticOption = args.find((argument) => ["-h", "--help", "-v", "--version"].includes(argument));
	if (staticOption !== undefined) {
		const kind = staticOption === "-h" || staticOption === "--help" ? "help" : "version";
		if (args.length !== 1) {
			throw new CliUsageError(`--${kind} must be used on its own.`);
		}
		return { kind };
	}

	let mode: OutputMode = "print";
	let explicitMode = false;
	let profile: string | undefined;
	let ui: string | undefined;
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
			explicitMode = true;
			continue;
		}
		if (argument === "--profile") {
			const value = args[index + 1];
			if (value === undefined || value.trim() === "")
				throw new CliUsageError("Option --profile requires a non-empty value.");
			if (profile !== undefined) throw new CliUsageError("Option --profile may only be used once.");
			profile = value;
			index++;
			continue;
		}
		if (argument === "--ui") {
			const value = args[index + 1];
			if (value === undefined || value.trim() === "")
				throw new CliUsageError("Option --ui requires a non-empty value.");
			if (ui !== undefined) throw new CliUsageError("Option --ui may only be used once.");
			ui = value;
			index++;
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
			explicitMode = true;
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

	if (profile !== undefined && profile !== "terminal" && profile !== "headless")
		throw new CliUsageError(`Unknown runtime profile "${profile}".`);
	if (profile === "terminal" && !explicitMode && !printAlias) mode = "interactive";
	if (profile === "headless" && !explicitMode && !printAlias) mode = "print";
	if (printAlias && mode !== "print") {
		throw new CliUsageError(`Cannot combine --print with --mode ${mode}.`);
	}
	if (continueSession && sessionPath !== undefined) {
		throw new CliUsageError("Cannot combine --continue with --session.");
	}
	if (mode === "interactive" && imagePaths.length > 0) {
		throw new CliUsageError("--image is not available in interactive mode.");
	}
	if (ui !== undefined && mode !== "interactive")
		throw new CliUsageError("Option --ui is only available in interactive mode.");
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
		...(profile ? { profile } : {}),
		...(ui ? { ui } : {}),
		...(projectTrust === undefined ? {} : { projectTrust }),
	};
}

function parseMcpArgs(args: readonly string[]): Extract<CliCommand, { kind: "mcp" }> {
	const action = args[0];
	if (action !== "add" && action !== "list" && action !== "get" && action !== "remove")
		throw new CliUsageError("MCP command must be add, list, get, or remove.");
	let scope: "local" | "project" | "user" | undefined;
	let transport: "stdio" | "http" | undefined;
	const positional: string[] = [];
	let separator = -1;
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--") {
			separator = index;
			break;
		}
		if (argument === "--scope") {
			const value = args[++index];
			if (value !== "local" && value !== "project" && value !== "user")
				throw new CliUsageError("Option --scope expects local, project, or user.");
			if (scope !== undefined) throw new CliUsageError("Option --scope may only be used once.");
			scope = value;
			continue;
		}
		if (argument === "--transport") {
			const value = args[++index];
			if (value !== "stdio" && value !== "http") throw new CliUsageError("Option --transport expects stdio or http.");
			if (transport !== undefined) throw new CliUsageError("Option --transport may only be used once.");
			transport = value;
			continue;
		}
		if (argument.startsWith("-")) throw new CliUsageError(`Unknown MCP option "${argument}".`);
		positional.push(argument);
	}
	if (separator >= 0) positional.push(...args.slice(separator + 1));
	if (action === "list") {
		if (transport !== undefined || positional.length > 0)
			throw new CliUsageError("MCP list accepts only an optional --scope.");
		return { kind: "mcp", action, ...(scope ? { scope } : {}) };
	}
	if (action === "get" || action === "remove") {
		if (transport !== undefined || positional.length !== 1 || positional[0].trim() === "")
			throw new CliUsageError(`MCP ${action} requires exactly one server id.`);
		return { kind: "mcp", action, serverId: positional[0], ...(scope ? { scope } : {}) };
	}
	const selectedTransport = transport ?? (separator >= 0 ? "stdio" : undefined);
	if (selectedTransport === undefined)
		throw new CliUsageError(
			"MCP add requires <server-id> -- <command> [args...] or --transport http <server-id> <url>.",
		);
	if (selectedTransport === "stdio") {
		if (positional.length < 2 || separator < 0)
			throw new CliUsageError("MCP stdio add requires <server-id> -- <command> [args...].");
		return {
			kind: "mcp",
			action,
			transport: "stdio",
			serverId: positional[0],
			command: positional[1],
			...(positional.length > 2 ? { args: positional.slice(2) } : {}),
			...(scope ? { scope } : {}),
		};
	}
	if (separator >= 0 || positional.length !== 2) throw new CliUsageError("MCP HTTP add requires <server-id> <url>.");
	return { kind: "mcp", action, transport, serverId: positional[0], url: positional[1], ...(scope ? { scope } : {}) };
}

export function helpText(locale: Locale): string {
	const t = (key: string) => translate(locale, key);
	return `${t("usage")}

${t("options")}
  -p, --print        ${t("print")}
  --mode <mode>      ${t("mode")}
  --interactive      ${t("interactive")}
  --profile <name>  Select the terminal or headless runtime profile
  --ui <id>         Select a registered interactive frontend
  --continue, -c     ${t("continueSession")}
  --session <path>   ${t("session")}
  --image <path>     ${t("image")}
  --skill <path>     ${t("skill")}
  --no-skills        ${t("noSkills")}
  --no-context-files ${t("noContextFiles")}
  --trust-project    ${t("trustProject")}
  --untrust-project  ${t("untrustProject")}
  plugin <action>    ${t("plugin")}
  mcp add|list|get|remove ${t("mcp")}
  -h, --help         ${t("help")}
  -v, --version      ${t("version")}
`;
}

export interface CliDependencies {
	stdout(text: string): void;
	stderr(text: string): void;
	run(command: Extract<CliCommand, { kind: "run" }>): Promise<number>;
	plugin?(command: Extract<CliCommand, { kind: "plugin" }>): Promise<number>;
	mcp?(command: Extract<CliCommand, { kind: "mcp" }>): Promise<number>;
	readonly version: string;
	readonly locale?: Locale;
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
			dependencies.stdout(helpText(dependencies.locale ?? DEFAULT_LOCALE));
			return 0;
		case "plugin":
			if (!dependencies.plugin) throw new Error("Plugin command handler is unavailable.");
			return dependencies.plugin(command);
		case "mcp":
			if (!dependencies.mcp) throw new Error("MCP command handler is unavailable.");
			return dependencies.mcp(command);
		case "version":
			dependencies.stdout(`${dependencies.version}\n`);
			return 0;
		case "run":
			return dependencies.run(command);
	}
}
