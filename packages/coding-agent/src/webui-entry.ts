#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { workspaceCapabilityKey } from "@di-code/builtins";
import { createCompositionLoader } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveManagedCompositionEntries,
} from "./compositions.ts";
import { createProjectTrustStore } from "./project-trust-entry.ts";
import { disposeRpcComposition } from "./rpc/lifecycle.ts";
import { pluginInventoryKey } from "./runtime/plugin-inventory-service.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";
import { WebUiServer } from "./webui.ts";

const allowedRoot = resolve(process.cwd());
const agentDir = resolve(join(homedir(), ".di-code"));
const token = process.env.DI_CODE_WEBUI_TOKEN;
const host = process.env.DI_CODE_WEBUI_HOST ?? "127.0.0.1";
const allowRemote = process.env.DI_CODE_WEBUI_ALLOW_REMOTE === "1";
const port = process.env.DI_CODE_WEBUI_PORT === undefined ? 0 : Number.parseInt(process.env.DI_CODE_WEBUI_PORT, 10);
let server: WebUiServer | undefined;
let loader: ReturnType<typeof createCompositionLoader> | undefined;
let context: ReturnType<typeof createRootContext> | undefined;

try {
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
		throw new Error("DI_CODE_WEBUI_PORT must be a TCP port.");
	if (token === undefined || token.length < 32)
		throw new Error("DI_CODE_WEBUI_TOKEN must contain at least 32 characters.");
	const projectTrusted = (await createProjectTrustStore(join(agentDir, "trust.json")).get(allowedRoot)) === true;
	context = createRootContext({ id: "webui-profile", mode: "webui", trustedProject: true });
	loader = createCompositionLoader({
		context,
		entries: [
			...(await resolveCompositionEntries("webui", {
				cwd: allowedRoot,
				agentDir,
				includeProjectComposition: true,
				allowedRoot,
			})),
			...(await resolveManagedCompositionEntries(agentDir)),
		],
		importModule: importCompositionModule,
		projectTrusted,
	});
	await loader.load();
	context.require(pluginInventoryKey).set(loader.tree.snapshot());
	const configuration = await loadStartupConfiguration(allowedRoot, process.env, agentDir);
	const runtime = resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
	server = new WebUiServer({
		context,
		allowedRoot: context.require(workspaceCapabilityKey).allowedRoot,
		agentDir,
		workspaceRegistryDir: resolve(join(homedir(), ".di-code")),
		provider: runtime.provider,
		model: runtime.model,
		projectTrusted,
		host,
		port,
		token,
		allowRemote,
		onProjectTrustChange: async (trusted) => {
			if (trusted) await loader?.loadTrustedProjectEntries();
			else await loader?.unloadProjectEntries();
			if (loader && context) context.require(pluginInventoryKey).set(loader.tree.snapshot());
		},
	});
	const address = await server.listen();
	process.stderr.write(`WebUI listening on http://${address.host}:${address.port}\n`);
	await new Promise<void>((resolvePromise) => {
		process.once("SIGINT", resolvePromise);
		process.once("SIGTERM", resolvePromise);
	});
} catch (cause) {
	process.stderr.write(`${cause instanceof Error ? cause.message : "WebUI startup failed."}\n`);
	process.exitCode = 1;
} finally {
	await server?.close();
	await disposeRpcComposition(
		() => loader?.dispose(),
		() => context?.dispose(),
	);
}
