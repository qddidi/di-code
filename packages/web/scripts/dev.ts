import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
let backend: ChildProcess | undefined;
let vite: ChildProcess | undefined;
let stopping = false;

function reservePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("Could not reserve a development port."));
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

function stop(code = 0): void {
	if (stopping) return;
	stopping = true;
	for (const child of [vite, backend]) child?.kill("SIGTERM");
	process.exitCode = code;
}

async function main(): Promise<void> {
	const vitePort = await reservePort();
	const viteOrigin = `http://127.0.0.1:${vitePort}`;
	const backendEntry = resolve(repositoryRoot, "packages/coding-agent/src/entry.ts");
	backend = spawn(process.execPath, ["--experimental-strip-types", backendEntry, "web", "--port", "0"], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			DI_CODE_WEB_STATIC_ROOT: resolve(repositoryRoot, "packages/coding-agent/dist/web"),
			DI_CODE_WEB_DEV_ORIGIN: viteOrigin,
		},
		stdio: ["ignore", "pipe", "inherit"],
	});
	let backendUrl = "";
	backend.stdout?.setEncoding("utf8");
	backend.stdout?.on("data", (chunk: string) => {
		process.stdout.write(chunk);
		const match = /Web server listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(chunk);
		if (!match || backendUrl) return;
		backendUrl = match[1];
		try {
			vite = spawn(
				process.execPath,
				[
					resolve(repositoryRoot, "node_modules/vite/bin/vite.js"),
					"--host",
					"127.0.0.1",
					"--port",
					String(vitePort),
					"--strictPort",
				],
				{
					cwd: resolve(repositoryRoot, "packages/web"),
					env: {
						...process.env,
						DI_CODE_WEB_DEV_BACKEND: backendUrl,
						DI_CODE_WEB_DEV_ORIGIN: viteOrigin,
					},
					stdio: "inherit",
				},
			);
			vite.once("error", () => stop(1));
			vite.once("exit", (code) => stop(code ?? 1));
		} catch {
			stop(1);
		}
	});
	backend.once("exit", (code) => stop(code ?? 1));
	backend.once("error", () => stop(1));
}

process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
await main();
