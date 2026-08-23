#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ProcessTerminal } from "@di-code/tui";
import packageMetadata from "../package.json" with { type: "json" };
import { runMain } from "./legacy-main.ts";
import { runMinimalProfile } from "./main.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import { loadStartupConfiguration, resolveStartupArgs, resolveStartupRuntime } from "./startup.ts";

async function promptProjectTrust(cwd: string): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await readline.question(`Trust project-local Skills, plugins, and extensions in ${cwd}? [y/N] `);
		return /^(?:y|yes)$/i.test(answer.trim());
	} finally {
		readline.close();
	}
}

try {
	const rawArgs = process.argv.slice(2);
	const args = resolveStartupArgs(rawArgs);
	const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const interactiveRequest =
		args.includes("--interactive") ||
		args.some((argument, index) => argument === "--mode" && args[index + 1] === "interactive");
	if (interactiveRequest && !isInteractiveTerminal) {
		process.stderr.write("Interactive mode requires an interactive TTY.\n");
		process.exitCode = 1;
	} else if (!interactiveRequest) {
		process.exitCode = await runMinimalProfile(rawArgs, {
			version: packageMetadata.version,
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
			onRuntimeEvent: (event) => {
				if (process.env.DI_CODE_TRACE_PLUGINS === "1") process.stderr.write(`${JSON.stringify(event)}\n`);
			},
			onSessionDisposed: () => {
				if (process.env.DI_CODE_TRACE_PLUGINS === "1") process.stderr.write('{"type":"session_dispose"}\n');
			},
		});
	} else {
		const configuration = await loadStartupConfiguration(process.cwd());
		process.exitCode = await runMain(args, {
			version: packageMetadata.version,
			createRuntime: (command) => {
				if (shouldStartProviderOnboarding(command, isInteractiveTerminal, configuration)) {
					return runProviderOnboarding({
						configuration,
						terminal: new ProcessTerminal(),
						agentDir: join(homedir(), ".di-code"),
					});
				}
				return resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
			},
			startupConfiguration: configuration,
			isInteractiveTerminal,
			promptProjectTrust,
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
		});
	}
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
