import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [
	"@di-code/ai",
	"@di-code/agent",
	"@di-code/tui",
	"@di-code/coding-agent",
	"@di-code/orchestrator",
];

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
		if (
			file.path !== "package.json" &&
			file.path !== "LICENSE" &&
			file.path !== "README.md" &&
			!file.path.startsWith("dist/")
		) {
			throw new Error(`${workspace} tarball contains unexpected file: ${file.path}`);
		}
	}
	if (!entry.files.some((file) => file.path === "README.md")) {
		throw new Error(`${workspace} tarball does not contain README.md`);
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
		for (const workspace of workspaces) {
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

		const help = await runNpm(["exec", "--offline", "--", "di-code", "--help"], { cwd: installDirectory });
		if (!help.stdout.startsWith("Usage: di-code")) throw new Error("Outside-install help smoke returned unexpected output.");
		const version = await runNpm(["exec", "--offline", "--", "di-code", "--version"], { cwd: installDirectory });
		if (version.stdout.trim() !== installedMetadata.version) {
			throw new Error(`Outside-install version mismatch: ${version.stdout.trim()}`);
		}
		const conversation = await runNpm(["exec", "--offline", "--", "di-code", "--print", "release smoke"], {
			cwd: installDirectory,
			env: { ...process.env, DI_CODE_PROVIDER: "faux" },
		});
		if (conversation.stdout.trim().length === 0) throw new Error("Outside-install conversation smoke returned no text.");

		const orchestratorSmoke = join(installDirectory, "orchestrator-smoke.mjs");
		await writeFile(
			orchestratorSmoke,
			`import { RpcSupervisor } from "@di-code/orchestrator";
const supervisor = new RpcSupervisor({
  command: process.execPath,
  args: [${JSON.stringify(rpcEntry)}],
  cwd: process.cwd(),
  env: { DI_CODE_PROVIDER: "faux" },
});
const state = await supervisor.start();
if (state.modelId !== "faux-model") throw new Error("unexpected RPC model");
const answer = await supervisor.prompt("orchestrator smoke");
if (answer.stopReason !== "stop") throw new Error("unexpected RPC answer");
await supervisor.stop();
`,
			"utf8",
		);
		await run(process.execPath, [orchestratorSmoke], { cwd: installDirectory });

		process.stdout.write(
			`release dry-run passed: ${workspaces.length} packages, version ${installedMetadata.version}, outside install and RPC smoke passed\n`,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

await main();
