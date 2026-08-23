#!/usr/bin/env node

import { resolve } from "node:path";
import { agentSessionKey, minimalProfile, rpcEventServiceKey, rpcMethodRegistryKey } from "@di-code/builtins";
import { type CompositionEntry, createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import { disposeRpcComposition } from "./rpc/lifecycle.ts";
import { RpcServer, type RpcSession } from "./rpc/server.ts";
import { installAgentSessionFactory } from "./runtime/session-factory.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

function moduleImporter(name: string): Promise<PluginModule> {
	return import(name) as Promise<PluginModule>;
}

function isRpcSession(value: unknown): value is RpcSession {
	return (
		typeof value === "object" &&
		value !== null &&
		"sessionId" in value &&
		"modelId" in value &&
		"isStreaming" in value &&
		"transcript" in value &&
		"prompt" in value &&
		"subscribeSession" in value &&
		typeof value.prompt === "function" &&
		typeof value.subscribeSession === "function"
	);
}

const allowedRoot = resolve(process.cwd());
const rpcProfileEntries = minimalProfile.entries.filter(
	(entry) => !["agent-loop", "mode-print", "mode-json", "mode-interactive"].includes(entry.id),
);
const context = createRootContext({ id: "rpc-profile", mode: "rpc", trustedProject: true });
const loader = createCompositionLoader({
	context,
	entries: rpcProfileEntries as readonly CompositionEntry[],
	importModule: moduleImporter,
	projectTrusted: true,
});

let server: RpcServer | undefined;
const stop = (): void => {
	void server?.shutdown().catch((error: Error) => process.stderr.write(`${error.message}\n`));
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
	const configuration = await loadStartupConfiguration(allowedRoot);
	const runtime = resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
	await loader.load();
	const removeFactory = installAgentSessionFactory(context.require(agentSessionKey));
	try {
		const session = await context.require(agentSessionKey).create({
			allowedRoot,
			provider: runtime.provider,
			model: runtime.model,
		});
		if (!isRpcSession(session)) throw new Error("SessionFactory returned an incompatible RPC session.");
		if (!context.require(rpcEventServiceKey).enabled()) throw new Error("RPC event projection is unavailable.");
		server = new RpcServer({
			session,
			methods: context.require(rpcMethodRegistryKey),
			input: process.stdin,
			output: process.stdout,
			onError: (error) => process.stderr.write(`${error.message}\n`),
		});
		server.start();
		await server.finished();
	} finally {
		removeFactory();
	}
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown RPC startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
} finally {
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	try {
		await disposeRpcComposition(
			() => loader.dispose(),
			() => context.dispose(),
		);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "Unknown RPC dispose error";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
