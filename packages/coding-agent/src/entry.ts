#!/usr/bin/env node

import packageMetadata from "../package.json" with { type: "json" };
import { runMain } from "./main.ts";
import { loadStartupConfiguration, resolveStartupArgs, resolveStartupRuntime } from "./startup.ts";

const configuration = await loadStartupConfiguration(process.cwd());
const exitCode = await runMain(resolveStartupArgs(process.argv.slice(2)), {
	version: packageMetadata.version,
	createRuntime: () => resolveStartupRuntime(configuration.environment, configuration.providers),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
});

process.exitCode = exitCode;
