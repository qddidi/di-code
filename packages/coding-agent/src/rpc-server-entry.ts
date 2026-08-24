import { homedir } from "node:os";
import { join } from "node:path";
import { modeRegistryKey, rpcMethodRegistryKey, runtimeSelectionKey, workspaceCapabilityKey } from "@di-code/builtins";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { RpcServer } from "./rpc/server.ts";
import { rpcServerKey } from "./rpc/server-service.ts";
import { createSessionHost } from "./runtime/session-host.ts";

export { type RpcServerService, rpcServerKey } from "./rpc/server-service.ts";

/** Creates the process RPC server from composition services and releases it with its owner Fiber. */
export const apiVersion = 1 as const;
export const name = "rpc-server";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = async (context, _config, fiber) => {
	const selection = context.require(runtimeSelectionKey).selected();
	const session = await createSessionHost(context, {
		cwd: context.require(workspaceCapabilityKey).allowedRoot,
		agentDir: join(homedir(), ".di-code"),
		provider: selection.provider,
		model: selection.model,
	});
	if (!session.state().activeSession) await session.createSession();
	const server = new RpcServer({
		session,
		methods: context.require(rpcMethodRegistryKey),
		productState: { projectTrusted: context.capabilities.trustedProject },
		input: process.stdin,
		output: process.stdout,
		onError: (error) => process.stderr.write(`${error.message}\n`),
	});
	await context.require(modeRegistryKey).execute("rpc", { run: () => server.start() });
	context.set(rpcServerKey, { shutdown: () => server.shutdown(), finished: () => server.finished() });
	fiber.addDisposer(async () => {
		await server.shutdown();
		await session.dispose();
	});
};
