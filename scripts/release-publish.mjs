import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = ["@di-code/ai", "@di-code/agent", "@di-code/tui", "@di-code/coding-agent", "@di-code/orchestrator"];
const workspaceDirectories = ["ai", "agent", "tui", "coding-agent", "orchestrator"];
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function npmCommand(args) {
	const npmEntry = process.env.npm_execpath;
	return npmEntry
		? { command: process.execPath, args: [npmEntry, ...args] }
		: { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`Command failed (code=${code} signal=${signal}): ${command} ${args.join(" ")}`));
		});
	});
}

async function readCommandOutput(command, args) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun(stdout);
			else rejectRun(new Error(`Command failed (code=${code} signal=${signal}): ${command} ${args.join(" ")}`));
		});
	});
}

function parseArguments() {
	if (process.argv.length !== 3 || process.argv[2] !== "--confirm") {
		throw new Error("Usage: npm run release:publish -- --confirm");
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
	parseArguments();
	const worktree = await readCommandOutput("git", ["status", "--porcelain"]);
	if (worktree.length > 0) {
		throw new Error("Refusing to publish from a dirty worktree. Commit or stash existing changes first.");
	}
	const root = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
	const version = root?.version;
	if (typeof version !== "string" || !stableVersionPattern.test(version)) {
		throw new Error("Root package.json must declare a stable semantic version before publishing.");
	}
	for (const directory of workspaceDirectories) {
		const packagePath = resolve(repositoryRoot, "packages", directory, "package.json");
		const metadata = JSON.parse(await readFile(packagePath, "utf8"));
		if (metadata?.version !== version) {
			throw new Error(`${packagePath} must use the root version ${version} before publishing.`);
		}
		for (const dependencyField of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
			for (const [name, dependencyVersion] of Object.entries(metadata[dependencyField] ?? {})) {
				if (name.startsWith("@di-code/") && dependencyVersion !== version) {
					throw new Error(`${packagePath} must depend on ${name} at version ${version}.`);
				}
			}
		}
	}
	const changelog = await readFile(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
	if (!new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(changelog)) {
		throw new Error(`CHANGELOG.md must contain a ## [${version}] entry before publishing.`);
	}

	const dryRun = npmCommand(["run", "release:dry-run"]);
	await run(dryRun.command, dryRun.args);

	for (const workspace of workspaces) {
		const publish = npmCommand(["publish", "--workspace", workspace, "--access", "public", "--ignore-scripts"]);
		await run(publish.command, publish.args);
	}
	process.stdout.write(`Published ${workspaces.length} packages at version ${version}\n`);
}

await main();
