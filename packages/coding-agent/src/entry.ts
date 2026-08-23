#!/usr/bin/env node

import packageMetadata from "../package.json" with { type: "json" };
import { runMinimalProfile } from "./main.ts";

try {
	process.exitCode = await runMinimalProfile(process.argv.slice(2), {
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
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
