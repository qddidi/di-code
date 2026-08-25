import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectories = ["ai", "agent", "tui", "skills", "mcp", "coding-agent", "web", "orchestrator"];
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function usage() {
	throw new Error("Usage: npm run version:prepare -- <major.minor.patch> [--dry-run]");
}

function parseArguments() {
	const argumentsWithoutDryRun = process.argv.slice(2).filter((argument) => argument !== "--dry-run");
	if (argumentsWithoutDryRun.length !== 1) usage();
	const version = argumentsWithoutDryRun[0];
	if (!stableVersionPattern.test(version)) {
		throw new Error(`Version must be a stable semantic version (major.minor.patch): ${version}`);
	}
	return { dryRun: process.argv.slice(2).includes("--dry-run"), version };
}

function compareVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < leftParts.length; index += 1) {
		if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
	}
	return 0;
}

async function readPackage(path) {
	const source = await readFile(path, "utf8");
	const metadata = JSON.parse(source);
	if (!metadata || typeof metadata !== "object" || typeof metadata.version !== "string") {
		throw new Error(`Invalid package metadata: ${path}`);
	}
	return { metadata, path, source };
}

function setVersions(metadata, targetVersion) {
	metadata.version = targetVersion;
	for (const field of dependencyFields) {
		const dependencies = metadata[field];
		if (!dependencies || typeof dependencies !== "object") continue;
		for (const name of Object.keys(dependencies)) {
			if (name.startsWith("@di-code/")) dependencies[name] = targetVersion;
		}
	}
}

function npmCommand(args) {
	const npmEntry = process.env.npm_execpath;
	return npmEntry
		? { command: process.execPath, args: [npmEntry, ...args] }
		: { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function run(command, args) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
		child.once("error", rejectRun);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`Command failed (code=${code} signal=${signal}): ${command} ${args.join(" ")}`));
		});
	});
}

async function main() {
	const { dryRun, version: targetVersion } = parseArguments();
	const packagePaths = [
		resolve(repositoryRoot, "package.json"),
		...workspaceDirectories.map((directory) => resolve(repositoryRoot, "packages", directory, "package.json")),
	];
	const packages = await Promise.all(packagePaths.map(readPackage));
	const currentVersion = packages[0].metadata.version;
	if (!packages.every(({ metadata }) => metadata.version === currentVersion)) {
		throw new Error("All workspace packages must use the same version before preparing a release.");
	}
	if (compareVersions(targetVersion, currentVersion) <= 0) {
		throw new Error(`Target version ${targetVersion} must be greater than current version ${currentVersion}.`);
	}

	if (dryRun) {
		process.stdout.write(`Version dry-run passed: ${currentVersion} -> ${targetVersion} for ${workspaceDirectories.length} packages\n`);
		return;
	}

	const lockfilePath = resolve(repositoryRoot, "package-lock.json");
	const lockfileSource = await readFile(lockfilePath, "utf8");
	try {
		for (const packageFile of packages) {
			setVersions(packageFile.metadata, targetVersion);
			await writeFile(packageFile.path, `${JSON.stringify(packageFile.metadata, null, "\t")}\n`, "utf8");
		}
		const invocation = npmCommand(["install", "--package-lock-only", "--ignore-scripts"]);
		await run(invocation.command, invocation.args);
	} catch (cause) {
		await Promise.all(packages.map(({ path, source }) => writeFile(path, source, "utf8")));
		await writeFile(lockfilePath, lockfileSource, "utf8");
		throw cause;
	}

	process.stdout.write(`Version prepared: ${currentVersion} -> ${targetVersion} for ${workspaceDirectories.length} packages\n`);
}

await main();
