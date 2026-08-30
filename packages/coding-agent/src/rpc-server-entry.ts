import { homedir } from "node:os";
import { join } from "node:path";
import { modeRegistryKey, rpcMethodRegistryKey, runtimeSelectionKey, workspaceCapabilityKey } from "@di-code/builtins";
import { ProjectTrustStore } from "@di-code/plugin-loader";
import type { PluginDefinition } from "@di-code/plugin-runtime";
import { createUserInteraction } from "@di-code/plugin-sdk";
import { RpcServer } from "./rpc/server.ts";
import { rpcServerKey } from "./rpc/server-service.ts";
import { createProductHost } from "./runtime/product-host.ts";
import { createSessionHost } from "./runtime/session-host.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

export { type RpcServerService, rpcServerKey } from "./rpc/server-service.ts";

/** Creates the process RPC server from composition services and releases it with its owner Fiber. */
export const apiVersion = 1 as const;
export const name = "rpc-server";
export const version = "0.1.7";
export const apply: PluginDefinition["apply"] = async (context, _config, fiber) => {
	const selection = context.require(runtimeSelectionKey).selected();
	const cwd = context.require(workspaceCapabilityKey).allowedRoot;
	const agentDir = join(homedir(), ".di-code");
	const projectTrusted = (await new ProjectTrustStore(join(agentDir, "trust.json")).get(cwd)) === true;
	let server: RpcServer | undefined;
	const interaction = createUserInteraction({
		request: async (input, signal) => {
			if (!server) throw new Error("RPC server is not ready.");
			return await server.requestInteraction(input, signal);
		},
	});
	const session = await createSessionHost(context, {
		cwd,
		agentDir,
		provider: selection.provider,
		model: selection.model,
		planMode: {
			section: "You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.",
		},
		interaction,
	});
	const product = createProductHost({
		context,
		cwd,
		agentDir,
		projectTrusted,
		provider: selection.provider,
		model: selection.model,
		runtimeSnapshot: () => {
			const ui = session.ui();
			return {
				providerId: ui.providerId,
				modelId: ui.modelId,
				...(ui.thinkingLevel ? { thinkingLevel: ui.thinkingLevel } : {}),
			};
		},
		reloadRuntime: async () => {
			const cwd = context.require(workspaceCapabilityKey).allowedRoot;
			const agentDir = join(homedir(), ".di-code");
			const configuration = await loadStartupConfiguration(cwd, process.env, agentDir);
			const runtime = resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
			session.setRuntimeValue(runtime.provider, runtime.model);
			return configuration;
		},
		reloadConfiguration: () =>
			loadStartupConfiguration(
				context.require(workspaceCapabilityKey).allowedRoot,
				process.env,
				join(homedir(), ".di-code"),
			),
		refreshResources: (projectTrusted) => session.refreshResources(projectTrusted),
	});
	if (!session.state().activeSession) await session.createSession();
	server = new RpcServer({
		session,
		methods: context.require(rpcMethodRegistryKey),
		productState: { projectTrusted },
		productHost: product,
		input: process.stdin,
		output: process.stdout,
		onError: (error) => process.stderr.write(`${error.message}\n`),
	});
	await context.require(modeRegistryKey).execute("rpc", { run: () => server.start() });
	context.set(rpcServerKey, { shutdown: () => server.shutdown(), finished: () => server.finished() });
	fiber.addDisposer(async () => {
		await server.shutdown();
		await interaction.dispose();
		await product.dispose();
		await session.dispose();
	});
};
