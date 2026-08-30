#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createCompositionLoader } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveManagedCompositionEntries,
} from "./compositions.ts";
import { createProjectTrustStore } from "./project-trust-entry.ts";
import { disposeRpcComposition } from "./rpc/lifecycle.ts";
import { rpcServerKey } from "./rpc/server-service.ts";

const allowedRoot = resolve(process.cwd());
const agentDir = resolve(join(homedir(), ".di-code"));
let loader: ReturnType<typeof createCompositionLoader> | undefined;
let context: ReturnType<typeof createRootContext> | undefined;
let shutdownRpc: (() => Promise<void>) | undefined;
const stop = (): void => {
	void shutdownRpc?.().catch((error: Error) => process.stderr.write(`${error.message}\n`));
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
	const projectTrusted = (await createProjectTrustStore(join(agentDir, "trust.json")).get(allowedRoot)) === true;
	context = createRootContext({ id: "rpc-profile", mode: "rpc", trustedProject: true });
	loader = createCompositionLoader({
		context,
		entries: [
			...(await resolveCompositionEntries("rpc", {
				cwd: allowedRoot,
				agentDir,
				includeProjectComposition: projectTrusted,
				allowedRoot,
			})),
			...(await resolveManagedCompositionEntries(agentDir)),
		],
		importModule: importCompositionModule,
		projectTrusted,
	});
	await loader.load();
	const rpcServer = context.require(rpcServerKey);
	shutdownRpc = rpcServer.shutdown;
	await rpcServer.finished();
} catch (cause) {
	const message = cause instanceof Error ? cause.message : "Unknown RPC startup error";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
} finally {
	shutdownRpc = undefined;
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	try {
		await disposeRpcComposition(
			() => loader?.dispose(),
			() => context?.dispose(),
		);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "Unknown RPC dispose error";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
