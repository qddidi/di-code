import type { CliParser } from "@di-code/builtins";
import { DEFAULT_LOCALE, type Locale, translate } from "./i18n.ts";

export type OutputMode = "print" | "json" | "interactive";
export type CompositionProfile = OutputMode;

export type CliCommand =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "web"; port: number; workspaces?: readonly string[] }
	| {
			kind: "observe";
			action: "trace" | "dump-composition";
			/** Applies an explicit Composition document after trusted project configuration. */
			compositionPath?: string;
			/** Excludes project-local Composition and discovered plugins for this observation. */
			noProjectPlugins?: true;
			/** Persists the current workspace trust decision before observing its resources. */
			projectTrust?: boolean;
	  }
	| {
			kind: "plugin";
			action:
				| "install"
				| "list"
				| "get"
				| "enable"
				| "disable"
				| "update"
				| "remove"
				| "create"
				| "doctor"
				| "trust"
				| "revoke";
			argument?: string;
	  }
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
			noSkills?: true;
			noContextFiles?: true;
			/** Selects the composition matching the output mode. */
			profile?: CompositionProfile;
			/** An explicit composition document applied after user and project layers. */
			compositionPath?: string;
			/** Excludes the project composition layer without affecting user-managed plugins. */
			noProjectPlugins?: true;
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
	if (args[0] === "web") return parseWebArgs(args.slice(1));
	const observe = parseObserveArgs(args);
	if (observe) return observe;
	if (args[0] === "plugin") {
		const action = args[1];
		if (
			action !== "install" &&
			action !== "list" &&
			action !== "get" &&
			action !== "enable" &&
			action !== "disable" &&
			action !== "update" &&
			action !== "remove" &&
			action !== "create" &&
			action !== "doctor" &&
			action !== "trust" &&
			action !== "revoke"
		)
			throw new CliUsageError(
				"Plugin command must be install, list, get, enable, disable, update, remove, create, doctor, trust, or revoke.",
			);
		const argument = args[2];
		if (
			args.length > 3 ||
			(action !== "list" &&
				action !== "trust" &&
				action !== "revoke" &&
				(argument === undefined || argument.trim() === "")) ||
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
	let printAlias = false;
	let sessionPath: string | undefined;
	let continueSession = false;
	let noSkills = false;
	let noContextFiles = false;
	let profile: CompositionProfile | undefined;
	let compositionPath: string | undefined;
	let noProjectPlugins = false;
	let modeWasSelected = false;
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
			if (profile !== undefined && profile !== "interactive") {
				throw new CliUsageError(`Cannot combine --profile ${profile} with --mode interactive.`);
			}
			mode = "interactive";
			modeWasSelected = true;
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
		if (argument === "--no-project-plugins") {
			noProjectPlugins = true;
			continue;
		}
		if (argument === "--profile") {
			const value = args[index + 1];
			if (value !== "print" && value !== "json" && value !== "interactive") {
				throw new CliUsageError("Option --profile expects print, json, or interactive.");
			}
			if (modeWasSelected && mode !== value) {
				throw new CliUsageError(`Cannot combine --profile ${value} with --mode ${mode}.`);
			}
			profile = value;
			mode = value;
			index++;
			continue;
		}
		if (argument === "--composition") {
			const value = args[index + 1];
			if (value === undefined || value.trim().length === 0) {
				throw new CliUsageError("Option --composition requires a non-empty path.");
			}
			if (compositionPath !== undefined) throw new CliUsageError("Option --composition may only be used once.");
			compositionPath = value;
			index++;
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
			if (profile !== undefined && profile !== value) {
				throw new CliUsageError(`Cannot combine --profile ${profile} with --mode ${value}.`);
			}
			mode = value;
			modeWasSelected = true;
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
		...(profile ? { profile } : {}),
		...(compositionPath ? { compositionPath } : {}),
		...(noProjectPlugins ? { noProjectPlugins: true as const } : {}),
		...(skillPaths.length > 0 ? { skillPaths } : {}),
		...(imagePaths.length > 0 ? { imagePaths } : {}),
		...(projectTrust === undefined ? {} : { projectTrust }),
	};
}

function parseObserveArgs(args: readonly string[]): Extract<CliCommand, { kind: "observe" }> | undefined {
	if (!args.some((argument) => argument === "--trace-plugins" || argument === "--dump-composition")) return undefined;
	let action: "trace" | "dump-composition" | undefined;
	let compositionPath: string | undefined;
	let noProjectPlugins = false;
	let projectTrust: boolean | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--trace-plugins" || argument === "--dump-composition") {
			const nextAction = argument === "--trace-plugins" ? "trace" : "dump-composition";
			if (action !== undefined) throw new CliUsageError("Use only one plugin observability command at a time.");
			action = nextAction;
			continue;
		}
		if (argument === "--trust-project" || argument === "--untrust-project") {
			const nextTrust = argument === "--trust-project";
			if (projectTrust !== undefined && projectTrust !== nextTrust)
				throw new CliUsageError("Cannot combine --trust-project with --untrust-project.");
			projectTrust = nextTrust;
			continue;
		}
		if (argument === "--no-project-plugins") {
			noProjectPlugins = true;
			continue;
		}
		if (argument === "--composition") {
			const value = args[index + 1];
			if (value === undefined || value.trim().length === 0)
				throw new CliUsageError("Option --composition requires a non-empty path.");
			if (compositionPath !== undefined) throw new CliUsageError("Option --composition may only be used once.");
			compositionPath = value;
			index++;
			continue;
		}
		throw new CliUsageError(`Unknown observability option "${argument}".`);
	}
	return action === undefined
		? undefined
		: {
				kind: "observe",
				action,
				...(compositionPath ? { compositionPath } : {}),
				...(noProjectPlugins ? { noProjectPlugins: true as const } : {}),
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

function parseWebArgs(args: readonly string[]): Extract<CliCommand, { kind: "web" }> {
	let port = 0;
	const workspaces: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--port") {
			const value = args[++index];
			if (value === undefined) throw new CliUsageError("Option --port requires a value.");
			port = Number(value);
		} else if (arg === "--workspace") {
			const value = args[++index];
			if (!value?.trim()) throw new CliUsageError("Option --workspace requires a path.");
			workspaces.push(value);
		} else throw new CliUsageError("Web command accepts --port <0-65535> and --workspace <path>.");
	}
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
		throw new CliUsageError("Option --port expects a TCP port from 0 to 65535.");
	return { kind: "web", port, ...(workspaces.length ? { workspaces } : {}) };
}

export function helpText(locale: Locale): string {
	const t = (key: string) => translate(locale, key);
	return `${t("usage")}

${t("options")}
  -p, --print        ${t("print")}
  --mode <mode>      ${t("mode")}
  --interactive      ${t("interactive")}
  --continue, -c     ${t("continueSession")}
  --session <path>   ${t("session")}
  --image <path>     ${t("image")}
  --skill <path>     ${t("skill")}
  --no-skills        ${t("noSkills")}
  --no-context-files ${t("noContextFiles")}
  --profile <profile> Select print, json, or interactive composition
  --composition <path> Apply a JSON or YAML composition after project configuration
  --no-project-plugins Skip .di-code/composition.yml for this run
  --trust-project    ${t("trustProject")}
  --untrust-project  ${t("untrustProject")}
  plugin <action>    ${t("plugin")} (install|list|get|enable|disable|update|remove|create|doctor|trust|revoke)
  --trace-plugins    Emit Loader phase, owner Fiber, capability, and failure diagnostics
  --dump-composition Emit the resolved composition without configuration values
  mcp add|list|get|remove ${t("mcp")}
  web [--port <port>] Start the local web application (default: an available port)
  -h, --help         ${t("help")}
  -v, --version      ${t("version")}
`;
}

/** Product-owned parser service consumed by the CLI composition entry. */
export function createCliParser(): CliParser<CliCommand> {
	return {
		parse: (args) => parseCliArgs(args),
		help: (locale) => helpText(locale === "zh-CN" ? "zh-CN" : "en"),
	};
}

export interface CliDependencies {
	stdout(text: string): void;
	stderr(text: string): void;
	run(command: Extract<CliCommand, { kind: "run" }>): Promise<number>;
	plugin?(command: Extract<CliCommand, { kind: "plugin" }>): Promise<number>;
	observe?(command: Extract<CliCommand, { kind: "observe" }>): Promise<number>;
	mcp?(command: Extract<CliCommand, { kind: "mcp" }>): Promise<number>;
	readonly version: string;
	readonly locale?: Locale;
	readonly parser?: CliParser<CliCommand>;
}

export async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
	let command: CliCommand;
	try {
		command = dependencies.parser?.parse(args) ?? parseCliArgs(args);
	} catch (cause) {
		if (cause instanceof CliUsageError) {
			dependencies.stderr(`${cause.message}\n`);
			return 1;
		}
		throw cause;
	}

	switch (command.kind) {
		case "help":
			dependencies.stdout(
				dependencies.parser?.help(dependencies.locale ?? DEFAULT_LOCALE) ??
					helpText(dependencies.locale ?? DEFAULT_LOCALE),
			);
			return 0;
		case "plugin":
			if (!dependencies.plugin) throw new Error("Plugin command handler is unavailable.");
			return dependencies.plugin(command);
		case "observe":
			if (!dependencies.observe) throw new Error("Plugin observability command handler is unavailable.");
			return dependencies.observe(command);
		case "mcp":
			if (!dependencies.mcp) throw new Error("MCP command handler is unavailable.");
			return dependencies.mcp(command);
		case "version":
			dependencies.stdout(`${dependencies.version}\n`);
			return 0;
		case "run":
			return dependencies.run(command);
		case "web":
			throw new Error("Web command must be handled by the executable entry point.");
	}
}
