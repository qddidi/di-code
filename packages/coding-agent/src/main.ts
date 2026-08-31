import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hostCommandRegistryKey, processExitKey, sessionStoreKey } from "@di-code/builtins";
import { createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext, type RuntimeEvent, redactSensitiveText } from "@di-code/plugin-runtime";
import { type CliCommand, createCliParser } from "./cli.ts";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveManagedCompositionEntries,
} from "./compositions.ts";
import { createProjectTrustStore } from "./project-trust-entry.ts";
import type { InteractiveBootstrapOptions } from "./runtime/interactive-host-service.ts";
import { pluginInventoryKey } from "./runtime/plugin-inventory-service.ts";

export interface MinimalProfileOptions {
	readonly version: string;
	readonly allowedRoot?: string;
	/** User data root used to resolve managed plugin state. */
	readonly agentDir?: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly onRuntimeEvent?: (event: RuntimeEvent) => void;
	readonly onSessionDisposed?: () => void;
	/** Terminal-only facilities supplied by the executable bootstrap. */
	readonly interactive?: InteractiveBootstrapOptions;
	/** Test-only namespace importer; production uses package-aware composition imports. */
	readonly importModule?: (name: string) => Promise<PluginModule>;
}

function errorMessage(cause: unknown): string {
	return redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
}

function isRun(command: CliCommand): command is Extract<CliCommand, { kind: "run" }> {
	return command.kind === "run";
}

function isMinimalCommand(
	command: CliCommand,
): command is Extract<CliCommand, { kind: "run" | "plugin" | "observe" | "mcp" }> {
	return command.kind === "run" || command.kind === "plugin" || command.kind === "observe" || command.kind === "mcp";
}

async function hasTrustedProjectContent(cwd: string): Promise<boolean> {
	for (const path of [
		join(cwd, ".di-code", "composition.yml"),
		join(cwd, ".di-code", "composition.yaml"),
		join(cwd, ".di-code", "plugins"),
		join(cwd, ".di-code", "skills"),
		join(cwd, ".agents", "skills"),
		join(cwd, ".di-code", "mcp.local.json"),
		join(cwd, ".mcp.json"),
	]) {
		try {
			await access(path);
			return true;
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		}
	}
	return false;
}

/** Starts a composition profile and executes its registered host command. */
export async function runMinimalProfile(args: readonly string[], options: MinimalProfileOptions): Promise<number> {
	const parser = createCliParser();
	let command: CliCommand;
	try {
		command = parser.parse(args);
	} catch (cause) {
		options.stderr(`${errorMessage(cause)}\n`);
		return 1;
	}
	if (command.kind === "help") {
		options.stdout(`${parser.help("en")}\n`);
		return 0;
	}
	if (command.kind === "version") {
		options.stdout(`${options.version}\n`);
		return 0;
	}
	if (!isMinimalCommand(command)) {
		options.stderr("MCP commands are unavailable in the minimal profile.\n");
		return 1;
	}
	if (isRun(command) && command.mode === "interactive" && !options.interactive?.isInteractiveTerminal) {
		options.stderr("Interactive mode requires an interactive TTY.\n");
		return 1;
	}
	const mode = isRun(command) ? command.mode : "print";
	const observability = command.kind === "observe";
	const allowedRoot = resolve(options.allowedRoot ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
	const trustStore = createProjectTrustStore(join(agentDir, "trust.json"));
	if (isRun(command) && command.projectTrust !== undefined) await trustStore.set(allowedRoot, command.projectTrust);
	let projectTrusted = isRun(command) && !command.noProjectPlugins && (await trustStore.get(allowedRoot)) === true;
	if (
		isRun(command) &&
		command.mode === "interactive" &&
		!projectTrusted &&
		command.projectTrust === undefined &&
		options.interactive?.promptProjectTrust &&
		(await hasTrustedProjectContent(allowedRoot))
	) {
		projectTrusted = await options.interactive.promptProjectTrust(allowedRoot);
		await trustStore.set(allowedRoot, projectTrusted);
	}
	const managedEntries = await resolveManagedCompositionEntries(agentDir);
	const compositionEntries = await resolveCompositionEntries(
		isRun(command) ? (command.profile ?? command.mode) : "base",
		{
			cwd: allowedRoot,
			agentDir,
			...(isRun(command) && command.compositionPath ? { compositionPath: command.compositionPath } : {}),
			includeProjectComposition: projectTrusted,
			observability,
			allowedRoot,
		},
	);
	const context = createRootContext({ id: "minimal-profile", mode, trustedProject: projectTrusted });
	const unsubscribe = context.events.subscribe((event) => options.onRuntimeEvent?.(event));
	const loader = createCompositionLoader({
		context,
		entries: [...compositionEntries, ...managedEntries],
		importModule: options.importModule ?? importCompositionModule,
		projectTrusted,
	});
	try {
		await loader.load();
		context.require(pluginInventoryKey).set(loader.tree.snapshot());
		const host = context.require(hostCommandRegistryKey);
		let name: string;
		let input: unknown;
		if (command.kind === "observe") {
			name = command.action === "trace" ? "trace-plugins" : "dump-composition";
			input = { stdout: options.stdout };
		} else if (command.kind === "plugin") {
			name = "plugin";
			input = { ...command, cwd: allowedRoot, stdout: options.stdout, stderr: options.stderr };
		} else if (command.kind === "mcp") {
			name = "mcp";
			input = { ...command, cwd: allowedRoot, stdout: options.stdout, stderr: options.stderr };
		} else if (command.mode === "interactive") {
			name = "interactive";
			input = {
				command,
				cwd: allowedRoot,
				agentDir,
				projectTrusted,
				stderr: options.stderr,
				...(options.interactive?.startInteractiveMode
					? { startInteractiveMode: options.interactive.startInteractiveMode }
					: {}),
			};
		} else {
			name = command.mode;
			input = { prompt: command.prompt, stdout: options.stdout };
		}
		const code = await host.execute(name, input, context.signal);
		const processExit = context.require(processExitKey);
		processExit.setCode(code);
		return processExit.code();
	} catch (cause) {
		options.stderr(`${errorMessage(cause).replace(/^Required entry agent-loop failed: /, "")}\n`);
		return 1;
	} finally {
		const memory = context.get(sessionStoreKey);
		try {
			try {
				await loader.dispose();
			} finally {
				await context.dispose();
			}
		} finally {
			unsubscribe();
			if (memory) {
				memory.dispose();
				if (memory.disposed()) options.onSessionDisposed?.();
			}
		}
	}
}
