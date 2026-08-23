import { hostCommandRegistryKey, minimalProfile, processExitKey, sessionStoreKey } from "@di-code/builtins";
import { type CompositionEntry, createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext, type RuntimeEvent } from "@di-code/plugin-runtime";
import { type CliCommand, helpText, parseCliArgs } from "./cli.ts";

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
	let command: CliCommand;
	try {
		command = parseCliArgs(args);
	} catch (cause) {
		options.stderr(`${errorMessage(cause)}\n`);
		return 1;
	}
	if (command.kind === "help") {
		options.stdout(`${helpText("en")}\n`);
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
	if (command.mode !== "print") {
		options.stderr("The minimal profile supports only --print.\n");
		return 1;
	}
	const context = createRootContext({ id: "minimal-profile", mode: "print", trustedProject: true });
	const unsubscribe = context.events.subscribe((event) => options.onRuntimeEvent?.(event));
	const loader = createCompositionLoader({
		context,
		entries: minimalProfile.entries as readonly CompositionEntry[],
		importModule: moduleImporter,
		projectTrusted: true,
	});
	try {
		await loader.load();
		const commandRegistry = context.require(hostCommandRegistryKey);
		const code = await commandRegistry.execute(
			"print",
			{ prompt: command.prompt, stdout: options.stdout },
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
