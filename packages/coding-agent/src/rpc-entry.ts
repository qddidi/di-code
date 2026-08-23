#!/usr/bin/env node

import { resolve } from "node:path";
import { agentSessionKey, rpcEventServiceKey, rpcMethodRegistryKey } from "@di-code/builtins";
import { createCompositionLoader } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import { importCompositionModule, resolveDefaultComposition } from "./compositions.ts";
import { disposeRpcComposition } from "./rpc/lifecycle.ts";
import { RpcServer, type RpcSession } from "./rpc/server.ts";
import { installAgentSessionFactory } from "./runtime/session-factory.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

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
const context = createRootContext({ id: "rpc-profile", mode: "rpc", trustedProject: true });
const loader = createCompositionLoader({
	context,
	entries: resolveDefaultComposition("rpc", { allowedRoot }),
	importModule: importCompositionModule,
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
	const removeFactory = installAgentSessionFactory(context);
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
		await removeFactory();
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
