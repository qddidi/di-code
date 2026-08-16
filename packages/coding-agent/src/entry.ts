#!/usr/bin/env node

import { ProcessTerminal } from "@di-code/tui";
import packageMetadata from "../package.json" with { type: "json" };
import { runMain } from "./main.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import { loadStartupConfiguration, resolveStartupArgs, resolveStartupRuntime } from "./startup.ts";

try {
	const configuration = await loadStartupConfiguration(process.cwd());
	process.exitCode = await runMain(resolveStartupArgs(process.argv.slice(2)), {
		version: packageMetadata.version,
		createRuntime: (command) => {
			const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
			if (shouldStartProviderOnboarding(command, isInteractiveTerminal, configuration)) {
				return runProviderOnboarding({ configuration, terminal: new ProcessTerminal() });
			}
			return resolveStartupRuntime(configuration.environment, configuration.providers);
		},
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	});
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
