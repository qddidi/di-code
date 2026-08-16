#!/usr/bin/env node

import { resolve } from "node:path";
import { AgentSession } from "./core/session.ts";
import { RpcServer } from "./rpc/server.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

try {
	const allowedRoot = resolve(process.cwd());
	const configuration = await loadStartupConfiguration(allowedRoot);
	const runtime = resolveStartupRuntime(configuration.environment, configuration.providers);
	const session = new AgentSession({
		allowedRoot,
		provider: runtime.provider,
		model: runtime.model,
	});
	const server = new RpcServer({
		session,
		input: process.stdin,
		output: process.stdout,
		onError: (error) => process.stderr.write(`${error.message}\n`),
	});
	server.start();
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown RPC startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
