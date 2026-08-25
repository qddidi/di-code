#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { redactSensitiveText } from "@di-code/plugin-runtime";
import packageMetadata from "../package.json" with { type: "json" };
import { parseCliArgs } from "./cli.ts";
import { runMinimalProfile } from "./main.ts";
import { resolveStartupArgs } from "./startup.ts";
import { runWebCommand } from "./web-command.ts";

async function promptProjectTrust(cwd: string): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await readline.question(`Trust project-local Skills and MCP configuration in ${cwd}? [y/N] `);
		return /^(?:y|yes)$/i.test(answer.trim());
	} finally {
		readline.close();
	}
}

try {
	const rawArgs = process.argv.slice(2);
	const args = resolveStartupArgs(rawArgs);
	const command = parseCliArgs(args);
	if (command.kind === "web") {
		process.exitCode = await runWebCommand(command);
	} else {
		const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
		process.exitCode = await runMinimalProfile(args, {
			version: packageMetadata.version,
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
			interactive: { isInteractiveTerminal, promptProjectTrust },
			onRuntimeEvent: (event) => {
				if (process.env.DI_CODE_TRACE_PLUGINS === "1") process.stderr.write(`${JSON.stringify(event)}\n`);
			},
			onSessionDisposed: () => {
				if (process.env.DI_CODE_TRACE_PLUGINS === "1") process.stderr.write('{"type":"session_dispose"}\n');
			},
		});
	}
} catch (cause) {
	const message = redactSensitiveText(cause instanceof Error ? cause.message : "Unknown startup error");
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
