import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { PLUGIN_API_VERSION, type PluginManifest, type PluginPermissions } from "./types.ts";

const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, name: string): string {
	const field = value[name];
	if (typeof field !== "string" || field.trim() === "")
		throw new Error(`plugin manifest ${name} must be a non-empty string`);
	return field;
}

function stringList(value: unknown, name: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== ""))
		throw new Error(`plugin manifest ${name} must be an array of non-empty strings`);
	return value;
}

function parsePermissions(value: unknown): PluginPermissions {
	if (!isRecord(value)) throw new Error("plugin manifest permissions must be an object");
	const filesystem = value.filesystem;
	if (filesystem !== "none" && filesystem !== "read-project")
		throw new Error('plugin manifest permissions.filesystem must be "none" or "read-project"');
	const network = stringList(value.network, "permissions.network");
	if (
		!network.every((url) => {
			try {
				return new URL(url).protocol === "https:";
			} catch {
				return false;
			}
		})
	)
		throw new Error("plugin manifest permissions.network only permits absolute HTTPS URLs");
	const process = stringList(value.process, "permissions.process");
	if (!process.every((command) => COMMAND_NAME.test(command)))
		throw new Error("plugin manifest permissions.process only permits exact command names");
	return { filesystem, network, process };
}

export function parsePluginManifest(value: unknown): PluginManifest {
	if (!isRecord(value)) throw new Error("plugin manifest must be an object");
	if (value.apiVersion !== PLUGIN_API_VERSION) throw new Error(`plugin API version must be ${PLUGIN_API_VERSION}`);
	const id = stringField(value, "id");
	if (id.length > 64 || !PLUGIN_ID.test(id))
		throw new Error("plugin manifest id must use lowercase letters, numbers, and single hyphens");
	const entry = stringField(value, "entry");
	if (isAbsolute(entry)) throw new Error("plugin manifest entry must be relative to the plugin root");
	return {
		apiVersion: PLUGIN_API_VERSION,
		id,
		name: stringField(value, "name"),
		version: stringField(value, "version"),
		entry,
		permissions: parsePermissions(value.permissions),
	};
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
