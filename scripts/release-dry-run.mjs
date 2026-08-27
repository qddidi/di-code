import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseWorkspaces } from "./release-packages.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function npmCommand(args) {
	const npmEntry = process.env.npm_execpath;
	return npmEntry
		? { command: process.execPath, args: [npmEntry, ...args] }
		: { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? repositoryRoot,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolveRun({ stdout, stderr });
				return;
			}
			rejectRun(
				new Error(
					`Command failed (code=${code} signal=${signal}): ${command} ${args.join(" ")}\n${stderr || stdout}`,
				),
			);
		});
	});
}

async function runNpm(args, options) {
	const invocation = npmCommand(args);
	return run(invocation.command, invocation.args, options);
}

function parsePackOutput(stdout, workspace) {
	let entries;
	try {
		entries = JSON.parse(stdout);
	} catch (cause) {
		throw new Error(`npm pack returned invalid JSON for ${workspace}`, { cause });
	}
	const entry = Array.isArray(entries) ? entries[0] : undefined;
	if (!entry || typeof entry.filename !== "string" || !Array.isArray(entry.files)) {
		throw new Error(`npm pack returned incomplete metadata for ${workspace}`);
	}
	for (const file of entry.files) {
		if (!file || typeof file.path !== "string") throw new Error(`npm pack returned an invalid file for ${workspace}`);
		const isCodingAgentComposition =
			workspace === "@di-code/coding-agent" && /^compositions\/[a-z-]+\.yml$/u.test(file.path);
		if (
			file.path !== "package.json" &&
			file.path !== "LICENSE" &&
			file.path !== "README.md" &&
			!file.path.startsWith("dist/") &&
			!isCodingAgentComposition
		) {
			throw new Error(`${workspace} tarball contains unexpected file: ${file.path}`);
		}
	}
	if (!entry.files.some((file) => file.path === "README.md")) {
		throw new Error(`${workspace} tarball does not contain README.md`);
	}
	if (workspace === "@di-code/coding-agent" && !entry.files.some((file) => file.path === "dist/web/index.html")) {
		throw new Error("@di-code/coding-agent tarball does not contain web assets.");
	}
	return entry;
}

async function main() {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "di-code-release-"));
	const packDirectory = join(temporaryRoot, "packs");
	const installDirectory = join(temporaryRoot, "outside-install");
	try {
		await mkdir(packDirectory, { recursive: true });
		await mkdir(installDirectory, { recursive: true });
		await runNpm(["run", "build"]);

		const tarballs = [];
		for (const workspace of releaseWorkspaces) {
			const dryRun = await runNpm(["pack", "--workspace", workspace, "--dry-run", "--json", "--ignore-scripts"]);
			parsePackOutput(dryRun.stdout, workspace);
			const packed = await runNpm([
				"pack",
				"--workspace",
				workspace,
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				packDirectory,
			]);
			const entry = parsePackOutput(packed.stdout, workspace);
			tarballs.push(join(packDirectory, entry.filename));
		}

		await writeFile(
			join(installDirectory, "package.json"),
			`${JSON.stringify({ name: "di-code-release-smoke", private: true, type: "module" }, null, 2)}\n`,
			"utf8",
		);
		await runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", ...tarballs], {
			cwd: installDirectory,
		});

		const codingAgentPackage = join(installDirectory, "node_modules", "@di-code", "coding-agent");
		const rpcEntry = join(codingAgentPackage, "dist", "rpc-entry.js");
		const binName = process.platform === "win32" ? "di-code.cmd" : "di-code";
		const binPath = join(installDirectory, "node_modules", ".bin", binName);
		await access(binPath);
		const installedMetadata = JSON.parse(await readFile(join(codingAgentPackage, "package.json"), "utf8"));
		const smokeEnvironment = { ...process.env, DI_CODE_LOCALE: "en" };

		const help = await runNpm(["exec", "--offline", "--", "di-code", "--help"], {
			cwd: installDirectory,
			env: smokeEnvironment,
		});
		if (!help.stdout.startsWith("Usage: di-code")) throw new Error("Outside-install help smoke returned unexpected output.");
		const version = await runNpm(["exec", "--offline", "--", "di-code", "--version"], { cwd: installDirectory });
		if (version.stdout.trim() !== installedMetadata.version) {
			throw new Error(`Outside-install version mismatch: ${version.stdout.trim()}`);
		}
		const orchestratorSmoke = join(installDirectory, "orchestrator-smoke.mjs");
		await writeFile(
			orchestratorSmoke,
			`import { RpcSupervisor } from "@di-code/orchestrator";
const supervisor = new RpcSupervisor({
  command: process.execPath,
  args: [${JSON.stringify(rpcEntry)}],
  cwd: process.cwd(),
  env: process.env,
});
const state = await supervisor.start();
if (!state.modelId) throw new Error("RPC server did not expose a model");
await supervisor.stop();
`,
			"utf8",
		);
		await run(process.execPath, [orchestratorSmoke], { cwd: installDirectory });
		await webSmoke(binPath, installDirectory, smokeEnvironment);

		process.stdout.write(
			`release dry-run passed: ${releaseWorkspaces.length} packages, version ${installedMetadata.version}, outside install, RPC, and web smoke passed\n`,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	}
}

async function webSmoke(binPath, cwd, env) {
	const windows = process.platform === "win32";
	const child = spawn(binPath, ["web", "--port", "0"], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		...(windows ? { shell: true } : {}),
	});
	let output = "";
	let error = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		error += chunk;
	});
	try {
		const baseUrl = await new Promise((resolveUrl, reject) => {
			let settled = false;
			const settle = (callback) => (value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				child.stdout.off("data", check);
				child.off("error", onError);
				child.off("exit", onExit);
				callback(value);
			};
			const timeout = setTimeout(
				() => settle(reject)(new Error(`Web smoke did not become ready.\n${error || output}`)),
				15_000,
			);
			const check = () => {
				const match = /Web server listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
				if (!match) return;
				settle(resolveUrl)(match[1]);
			};
			const onError = (cause) => settle(reject)(cause);
			const onExit = (code) =>
				settle(reject)(new Error(`Web smoke exited before readiness (code=${code}).\n${error || output}`));
			child.stdout.on("data", check);
			child.once("error", onError);
			child.once("exit", onExit);
			check();
		});
		const page = await fetch(baseUrl);
		const html = await page.text();
		if (!page.ok || html.trim().length === 0) throw new Error("Web smoke returned an empty page.");
		const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie) throw new Error("Web smoke did not establish a same-origin session.");
		const boot = await fetch(`${baseUrl}/api/boot`, { headers: { cookie } });
		const data = await boot.json();
		if (!boot.ok || !Array.isArray(data?.capabilities?.methods) || data.capabilities.methods.length === 0)
			throw new Error("Web smoke did not expose RPC capabilities.");
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			if (windows) {
				const killer = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `taskkill /pid ${child.pid} /t /f`], {
					stdio: "ignore",
				});
				await new Promise((resolveExit) => killer.once("exit", resolveExit));
			} else child.kill("SIGTERM");
		}
		if (child.exitCode === null && child.signalCode === null)
			await new Promise((resolveExit) => child.once("exit", resolveExit));
	}
}

await main();
