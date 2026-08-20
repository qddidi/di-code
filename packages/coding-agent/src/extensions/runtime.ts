// Frozen migration baseline. New loaders must not discover .di-code/extensions.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { validateToolArguments } from "@di-code/ai";
import type { ProjectTrustManager } from "./trust.ts";
import type {
	ExtensionAPI,
	ExtensionCommand,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	ExtensionEventHandler,
	ExtensionEventMap,
	ExtensionFactory,
	ExtensionReadOnlyTool,
} from "./types.ts";

export interface ExtensionHostOptions {
	readonly cwd: string;
	readonly mode: ExtensionContext["mode"];
	readonly projectTrusted: boolean;
	readonly abort?: () => void;
}

export interface LoadedExtension {
	readonly path: string;
}

export type ExtensionDiagnosticStage = "discover" | "import" | "factory" | "register" | "handler";

export interface ExtensionDiagnostic {
	readonly path: string;
	readonly stage: ExtensionDiagnosticStage;
	readonly message: string;
}

export interface ExtensionLoadOptions {
	readonly cwd: string;
	readonly projectTrusted?: boolean;
	readonly trustManager?: ProjectTrustManager;
	readonly paths?: readonly string[];
	readonly mode?: ExtensionContext["mode"];
}

export interface ExtensionLoadResult {
	readonly host: ExtensionHost;
	readonly loaded: readonly LoadedExtension[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

function isExtensionPath(path: string): boolean {
	return extname(path) === ".js" || extname(path) === ".mjs" || extname(path) === ".ts";
}

function createContext(options: ExtensionHostOptions, signal?: AbortSignal): ExtensionContext {
	return {
		cwd: options.cwd,
		mode: options.mode,
		signal,
		isProjectTrusted: () => options.projectTrusted,
		abort: options.abort ?? (() => {}),
	};
}

export class ExtensionHost {
	private readonly options: ExtensionHostOptions;
	private readonly context: ExtensionContext;
	private readonly commands = new Map<string, ExtensionCommand>();
	private readonly tools = new Map<string, ExtensionReadOnlyTool>();
	private readonly handlers = new Map<
		keyof ExtensionEventMap,
		readonly { path: string; handler: ExtensionEventHandler<keyof ExtensionEventMap> }[]
	>();
	private readonly runtimeDiagnostics: ExtensionDiagnostic[] = [];

	constructor(options: ExtensionHostOptions) {
		this.options = options;
		this.context = createContext(options);
	}

	get extensionContext(): ExtensionContext {
		return this.context;
	}

	listCommands(): readonly ExtensionCommand[] {
		return [...this.commands.values()];
	}

	listTools(): readonly ExtensionReadOnlyTool[] {
		return [...this.tools.values()];
	}

	listRuntimeDiagnostics(): readonly ExtensionDiagnostic[] {
		return [...this.runtimeDiagnostics];
	}

	async registerExtension(_path: string, factory: ExtensionFactory, pluginId?: string): Promise<void> {
		const commands: ExtensionCommand[] = [];
		const tools: ExtensionReadOnlyTool[] = [];
		const handlers = new Map<keyof ExtensionEventMap, ExtensionEventHandler<keyof ExtensionEventMap>[]>();
		const api: ExtensionAPI = {
			registerCommand: (command) => commands.push(command),
			registerTool: (tool) => tools.push(tool),
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler as ExtensionEventHandler<keyof ExtensionEventMap>);
				handlers.set(event, list);
			},
		};
		await factory(api);

		for (const command of commands) {
			if (RESERVED_INTERACTIVE_COMMANDS.has(command.name))
				throw new Error(`Extension command conflicts with built-in command: ${command.name}`);
			if (this.commands.has(command.name)) throw new Error(`Extension command conflict: "${command.name}"`);
		}
		for (const tool of tools) {
			if (pluginId !== undefined && !tool.name.startsWith(`${pluginId}__`))
				throw new Error(`Plugin tool namespace conflict: ${tool.name}`);
			if (this.tools.has(tool.name)) throw new Error(`Extension tool conflict: "${tool.name}"`);
		}
		for (const command of commands) this.commands.set(command.name, command);
		for (const tool of tools) this.tools.set(tool.name, tool);
		for (const [event, list] of handlers) {
			const existing = this.handlers.get(event) ?? [];
			this.handlers.set(event, [...existing, ...list.map((handler) => ({ path: _path, handler }))]);
		}
	}

	async emit<E extends keyof ExtensionEventMap>(event: ExtensionEventMap[E], signal?: AbortSignal): Promise<void> {
		const list = this.handlers.get(event.type) ?? [];
		const context = createContext(this.options, signal);
		for (const { path, handler } of list) {
			try {
				await handler(event as ExtensionEvent, context);
			} catch (cause) {
				this.runtimeDiagnostics.push({
					path,
					stage: "handler",
					message: `Extension event handler failed: ${safeDiagnosticMessage(cause)}`,
				});
			}
		}
	}

	async runCommand(name: string, args: string): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`Unknown extension command: "${name}"`);
		const commandContext: ExtensionCommandContext = { ...this.context, args };
		await command.handler(commandContext);
	}

	async runTool(
		name: string,
		toolCallId: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<readonly import("@di-code/ai").ToolResultContent[]> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`Unknown extension tool: "${name}"`);
		let parameters: unknown;
		try {
			parameters = validateToolArguments(tool, input);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Tool arguments invalid: ${message}`, { cause });
		}
		return tool.execute(toolCallId, parameters as never, signal, createContext(this.options, signal));
	}
}

const RESERVED_INTERACTIVE_COMMANDS = new Set([
	"help",
	"clear",
	"model",
	"session",
	"theme",
	"settings",
	"compact",
	"usage",
	"retry",
]);

function safeDiagnosticMessage(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	return message.replace(/(api[_-]?key|token|secret|authorization)=[^\\s]+/gi, "$1=[redacted]").slice(0, 500);
}

async function discoverProjectPaths(cwd: string): Promise<string[]> {
	const candidates = [join(cwd, ".di-code", "extensions")];
	const paths: string[] = [];
	for (const directory of candidates) {
		if (!existsSync(directory)) continue;
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && isExtensionPath(entry.name)) paths.push(resolve(directory, entry.name));
		}
	}
	return paths.sort((a, b) => a.localeCompare(b));
}

async function importFactory(path: string): Promise<ExtensionFactory> {
	let module: { default?: unknown };
	try {
		module = (await import(path)) as { default?: unknown };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to import extension: ${message}`, { cause });
	}
	if (typeof module.default !== "function") throw new Error("Extension module must export a default factory function");
	return module.default as ExtensionFactory;
}

export async function loadExtensions(options: ExtensionLoadOptions): Promise<ExtensionLoadResult> {
	const cwd = resolve(options.cwd);
	const persistedDecision = options.projectTrusted === undefined ? await options.trustManager?.get(cwd) : null;
	const projectTrusted = options.projectTrusted ?? persistedDecision === true;
	const host = new ExtensionHost({ cwd, mode: options.mode ?? "json", projectTrusted });
	const diagnostics: ExtensionDiagnostic[] = [];
	const explicitPaths = [...(options.paths ?? [])].map((path) => resolve(cwd, path));
	const projectPaths = projectTrusted ? await discoverProjectPaths(cwd) : [];
	if (!projectTrusted) {
		const projectDirectories = [join(cwd, ".di-code", "extensions")];
		for (const directory of projectDirectories) {
			if (existsSync(directory)) {
				diagnostics.push({
					path: directory,
					stage: "discover",
					message: "Project extension skipped because project trust is not granted",
				});
			}
		}
	}
	const paths = [...new Set([...explicitPaths, ...projectPaths])].sort((a, b) => a.localeCompare(b));
	const loaded: LoadedExtension[] = [];
	for (const path of paths) {
		try {
			const factory = await importFactory(path);
			await host.registerExtension(path, factory);
			loaded.push({ path });
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			const stage: ExtensionDiagnosticStage = message.startsWith("Extension module")
				? "factory"
				: message.startsWith("Extension command conflict") || message.startsWith("Extension tool conflict")
					? "register"
					: message.startsWith("Failed to import extension")
						? "import"
						: "factory";
			diagnostics.push({
				path,
				stage,
				message:
					stage === "factory" && message !== "Extension module must export a default factory function"
						? `Failed to load extension: ${message}`
						: message,
			});
		}
	}
	return { host, loaded, diagnostics };
}

export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
	return new ExtensionHost(options);
}
