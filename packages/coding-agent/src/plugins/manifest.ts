import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { type PluginManifest, parsePluginManifest } from "@di-code/plugin-runtime";

export type { PluginManifest } from "@di-code/plugin-runtime";

export { parsePluginManifest };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readPluginManifest(manifestPath: string): Promise<PluginManifest> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {
		throw new Error("plugin manifest is not valid JSON");
	}
	return parsePluginManifest(parsed);
}

export async function readPackagePluginManifest(root: string): Promise<PluginManifest> {
	let packageJson: unknown;
	try {
		packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	} catch {
		throw new Error("plugin package.json is not valid JSON");
	}
	if (!isRecord(packageJson) || !isRecord(packageJson.diCode))
		throw new Error("plugin package.json must include a diCode object");
	const diCode = packageJson.diCode;
	const entries = diCode.plugins;
	if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== "string")
		throw new Error("plugin package diCode.plugins must contain exactly one entry");
	return parsePluginManifest({
		apiVersion: diCode.apiVersion,
		id: typeof packageJson.name === "string" ? packageJson.name.replace(/^@[^/]+\//, "") : "package-plugin",
		name: packageJson.name,
		version: packageJson.version,
		entry: entries[0],
		permissions: diCode.permissions ?? { filesystem: "none", network: [], process: [] },
		capabilities: diCode.capabilities,
	});
}

export async function resolvePluginEntry(root: string, entry: string): Promise<string> {
	const resolvedRoot = await realpath(root);
	const candidate = resolve(resolvedRoot, entry);
	const relativeCandidate = relative(resolvedRoot, candidate);
	if (relativeCandidate.startsWith("..") || relativeCandidate === "")
		throw new Error("plugin entry must stay inside the plugin root");
	let resolvedEntry: string;
	try {
		resolvedEntry = await realpath(candidate);
	} catch {
		throw new Error("plugin entry does not exist");
	}
	if (relative(resolvedRoot, resolvedEntry).startsWith(".."))
		throw new Error("plugin entry symlink escapes the plugin root");
	if (!(await lstat(resolvedEntry)).isFile()) throw new Error("plugin entry must be a file");
	return resolvedEntry;
}

export function pluginRootFromManifest(manifestPath: string): string {
	return dirname(manifestPath);
}
