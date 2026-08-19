#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ProcessTerminal } from "@di-code/tui";
import packageMetadata from "../package.json" with { type: "json" };
import { runMain } from "./main.ts";
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
	const configuration = await loadStartupConfiguration(process.cwd());
	process.exitCode = await runMain(resolveStartupArgs(process.argv.slice(2)), {
		version: packageMetadata.version,
		createRuntime: (command) => {
			const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
		isInteractiveTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		promptProjectTrust,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	});
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
