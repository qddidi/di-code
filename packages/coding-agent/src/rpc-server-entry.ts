import {
	agentSessionKey,
	modeRegistryKey,
	rpcMethodRegistryKey,
	runtimeSelectionKey,
	workspaceCapabilityKey,
} from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { RpcServer, type RpcSession } from "./rpc/server.ts";
import { rpcServerKey } from "./rpc/server-service.ts";

export { type RpcServerService, rpcServerKey } from "./rpc/server-service.ts";

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

/** Creates the process RPC server from composition services and releases it with its owner Fiber. */
export const apiVersion = 1 as const;
export const name = "rpc-server";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = async (context, _config, fiber) => {
	const selection = context.require(runtimeSelectionKey).selected();
	const session = await context.require(agentSessionKey).create({
		allowedRoot: context.require(workspaceCapabilityKey).allowedRoot,
		provider: selection.provider,
		model: selection.model,
	});
	if (!isRpcSession(session)) throw new Error("SessionFactory returned an incompatible RPC session.");
	const server = new RpcServer({
		session,
		methods: context.require(rpcMethodRegistryKey),
		input: process.stdin,
		output: process.stdout,
		onError: (error) => process.stderr.write(`${error.message}\n`),
	});
	await context.require(modeRegistryKey).execute("rpc", { run: () => server.start() });
	context.set(rpcServerKey, { shutdown: () => server.shutdown(), finished: () => server.finished() });
	fiber.addDisposer(async () => await server.shutdown());
};
