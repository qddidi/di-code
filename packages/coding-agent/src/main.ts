import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentLoopKey, modeRegistryKey, processExitKey, rendererRegistryKey, sessionStoreKey } from "@di-code/builtins";
import { createCompositionLoader, ProjectTrustStore } from "@di-code/plugin-loader";
import { createRootContext, type RuntimeEvent, redactSensitiveText } from "@di-code/plugin-runtime";
import { type CliCommand, createCliParser } from "./cli.ts";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveManagedCompositionEntries,
} from "./compositions.ts";
import { pluginInventoryKey } from "./runtime/plugin-inventory-entry.ts";
import { pluginManagerKey } from "./runtime/plugin-manager-entry.ts";
import { pluginDumpCompositionKey, pluginTraceKey } from "./runtime/plugin-observability-entry.ts";

export interface MinimalProfileOptions {
	readonly version: string;
	readonly allowedRoot?: string;
	/** User data root used to resolve managed plugin state. */
	readonly agentDir?: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly onRuntimeEvent?: (event: RuntimeEvent) => void;
	readonly onSessionDisposed?: () => void;
}

function errorMessage(cause: unknown): string {
	return redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
}

function isRun(command: CliCommand): command is Extract<CliCommand, { kind: "run" }> {
	return command.kind === "run";
}

function isMinimalCommand(command: CliCommand): command is Extract<CliCommand, { kind: "run" | "plugin" | "observe" }> {
	return command.kind === "run" || command.kind === "plugin" || command.kind === "observe";
}

/** Starts the Stage 7 minimal composition and executes its registered host command. */
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
	const mode = isRun(command) ? command.mode : "print";
	const observability = command.kind === "observe";
	const allowedRoot = resolve(options.allowedRoot ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
	const trustStore = new ProjectTrustStore(join(agentDir, "trust.json"));
	if (isRun(command) && command.projectTrust !== undefined) await trustStore.set(allowedRoot, command.projectTrust);
	const projectTrusted = isRun(command) && !command.noProjectPlugins && (await trustStore.get(allowedRoot)) === true;
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
		importModule: importCompositionModule,
		projectTrusted,
	});
	try {
		await loader.load();
		context.require(pluginInventoryKey).set(loader.tree.snapshot());
		if (command.kind === "observe") {
			const service =
				command.action === "trace" ? context.require(pluginTraceKey) : context.require(pluginDumpCompositionKey);
			options.stdout(`${service.render(loader.tree.snapshot())}\n`);
			return 0;
		}
		if (command.kind === "plugin") {
			return await context
				.require(pluginManagerKey)
				.execute({ ...command, stdout: options.stdout, stderr: options.stderr });
		}
		if (!isRun(command)) throw new Error("Minimal profile command is unavailable");
		const modes = context.require(modeRegistryKey);
		const code = await modes.execute(
			command.mode,
			command.mode === "print"
				? { prompt: command.prompt, stdout: options.stdout }
				: command.mode === "json"
					? {
							run: async () => {
								const renderer = context.require(rendererRegistryKey).find("json");
								if (!renderer) throw new Error("JSON renderer is unavailable");
								const loop = context.require(agentLoopKey);
								const unsubscribe = loop.agent.subscribe((event) => {
									const rendered = renderer.render(event);
									if (rendered !== undefined) options.stdout(`${rendered}\n`);
								});
								try {
									const response = await loop.prompt(command.prompt, context.signal);
									return response.stopReason === "error" || response.stopReason === "aborted" ? 1 : 0;
								} finally {
									unsubscribe();
								}
							},
						}
					: { run: () => Promise.reject(new Error("Interactive mode requires a session context")) },
			context.signal,
		);
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
