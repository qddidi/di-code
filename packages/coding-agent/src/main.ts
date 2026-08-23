import {
	agentLoopKey,
	minimalProfile,
	modeRegistryKey,
	processExitKey,
	rendererRegistryKey,
	sessionStoreKey,
} from "@di-code/builtins";
import { type CompositionEntry, createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext, type RuntimeEvent } from "@di-code/plugin-runtime";
import { type CliCommand, createCliParser } from "./cli.ts";

export interface MinimalProfileOptions {
	readonly version: string;
	readonly allowedRoot?: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly onRuntimeEvent?: (event: RuntimeEvent) => void;
	readonly onSessionDisposed?: () => void;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isRun(command: CliCommand): command is Extract<CliCommand, { kind: "run" }> {
	return command.kind === "run";
}

function moduleImporter(name: string): Promise<PluginModule> {
	return import(name) as Promise<PluginModule>;
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
	if (!isRun(command)) {
		options.stderr("Only run commands are available in the minimal profile.\n");
		return 1;
	}
	const context = createRootContext({ id: "minimal-profile", mode: command.mode, trustedProject: true });
	const unsubscribe = context.events.subscribe((event) => options.onRuntimeEvent?.(event));
	const loader = createCompositionLoader({
		context,
		entries: minimalProfile.entries as readonly CompositionEntry[],
		importModule: moduleImporter,
		projectTrusted: true,
	});
	try {
		await loader.load();
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
