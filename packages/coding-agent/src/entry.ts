#!/usr/bin/env node

import packageMetadata from "../package.json" with { type: "json" };
import { runMain } from "./main.ts";

const exitCode = await runMain(process.argv.slice(2), {
	version: packageMetadata.version,
	fauxResponses: [{ type: "success", content: [{ type: "text", text: "Faux response." }] }],
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	env: process.env,
	cwd: process.cwd(),
	allowModelNetwork: true,
});

process.exitCode = exitCode;
