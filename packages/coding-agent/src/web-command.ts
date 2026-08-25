import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceCapabilityKey } from "@di-code/builtins";
import { createCompositionLoader } from "@di-code/plugin-loader";
import { createRootContext } from "@di-code/plugin-runtime";
import type { CliCommand } from "./cli.ts";
import {
	importCompositionModule,
	resolveCompositionEntries,
	resolveManagedCompositionEntries,
} from "./compositions.ts";
import { createProjectTrustStore } from "./project-trust-entry.ts";
import { disposeRpcComposition } from "./rpc/lifecycle.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";
import { WebUiServer } from "./webui.ts";

type WebCommand = Extract<CliCommand, { readonly kind: "web" }>;

async function webAssetRoot(): Promise<string> {
	if (process.env.DI_CODE_WEB_STATIC_ROOT) return await existingDirectory(process.env.DI_CODE_WEB_STATIC_ROOT);
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(moduleDirectory, "web"), resolve(moduleDirectory, "../dist/web")]) {
		try {
			return await existingDirectory(candidate);
		} catch {}
	}
	throw new Error("Web assets are missing. Reinstall @di-code/coding-agent or run npm run build.");
}

async function existingDirectory(path: string): Promise<string> {
	await access(resolve(path));
	return resolve(path);
}

function developmentOrigin(): string | undefined {
	const value = process.env.DI_CODE_WEB_DEV_ORIGIN;
	if (!value) return undefined;
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		throw new Error("DI_CODE_WEB_DEV_ORIGIN must be an http loopback origin.");
	}
	if (origin.protocol !== "http:" || (origin.hostname !== "127.0.0.1" && origin.hostname !== "::1"))
		throw new Error("DI_CODE_WEB_DEV_ORIGIN must be an http loopback origin.");
	return origin.origin;
}

/** Starts the local same-origin SPA, HTTP/SSE RPC transport, boot route, and health endpoint. */
export async function runWebCommand(command: WebCommand): Promise<number> {
	const allowedRoot = resolve(process.cwd());
	const agentDir = resolve(join(homedir(), ".di-code"));
	const projectTrusted = (await createProjectTrustStore(join(agentDir, "trust.json")).get(allowedRoot)) === true;
	const context = createRootContext({ id: "web-profile", mode: "webui", trustedProject: projectTrusted });
	const loader = createCompositionLoader({
		context,
		entries: [
			...(await resolveCompositionEntries("webui", {
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
	let server: WebUiServer | undefined;
	try {
		await loader.load();
		const configuration = await loadStartupConfiguration(allowedRoot, process.env, agentDir);
		const runtime = resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
		server = new WebUiServer({
			context,
			allowedRoot: context.require(workspaceCapabilityKey).allowedRoot,
			agentDir,
			provider: runtime.provider,
			model: runtime.model,
			projectTrusted,
			port: command.port,
			token: randomBytes(32).toString("base64url"),
			staticRoot: await webAssetRoot(),
			developmentOrigin: developmentOrigin(),
		});
		const address = await server.listen();
		process.stdout.write(`Web server listening at http://${address.host}:${address.port}\n`);
		await waitForSignal();
		return 0;
	} finally {
		await server?.close();
		await disposeRpcComposition(
			() => loader.dispose(),
			() => context.dispose(),
		);
	}
}

function waitForSignal(): Promise<void> {
	return new Promise((resolveSignal) => {
		const done = (): void => {
			process.off("SIGINT", done);
			process.off("SIGTERM", done);
			resolveSignal();
		};
		process.once("SIGINT", done);
		process.once("SIGTERM", done);
	});
}
