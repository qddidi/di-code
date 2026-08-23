import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { Context, Fiber, PluginDefinition } from "@di-code/plugin-runtime";
import { parse as parseYaml } from "yaml";

export type PluginModule<Config = unknown> = {
	readonly [exportName: string]: unknown;
} & Partial<PluginDefinition<Config>>;

export const PLUGIN_API_VERSION = 1 as const;
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export interface PluginPermissions {
	readonly filesystem: "none" | "read-project" | "workspace" | "user" | "unrestricted";
	readonly network: readonly string[];
	readonly process: readonly string[];
}

export interface PluginManifest {
	readonly apiVersion: typeof PLUGIN_API_VERSION;
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly entry: string;
	readonly permissions: PluginPermissions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, field: string): string {
	const result = value[field];
	if (typeof result !== "string" || result.trim() === "")
		throw new Error(`plugin manifest ${field} must be a non-empty string`);
	return result;
}

function stringList(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== ""))
		throw new Error(`plugin manifest ${field} must be an array of non-empty strings`);
	return value;
}

function parsePermissions(value: unknown): PluginPermissions {
	if (!isRecord(value)) throw new Error("plugin manifest permissions must be an object");
	const filesystem = value.filesystem;
	if (
		filesystem !== "none" &&
		filesystem !== "read-project" &&
		filesystem !== "workspace" &&
		filesystem !== "user" &&
		filesystem !== "unrestricted"
	)
		throw new Error("plugin manifest permissions.filesystem is invalid");
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

/** Validates the durable manifest before a plugin is imported. */
export function parsePluginManifest(value: unknown): PluginManifest {
	if (!isRecord(value)) throw new Error("plugin manifest must be an object");
	if (value.apiVersion !== PLUGIN_API_VERSION) throw new Error(`plugin API version must be ${PLUGIN_API_VERSION}`);
	const id = requiredString(value, "id");
	if (id.length > 64 || !PLUGIN_ID.test(id))
		throw new Error("plugin manifest id must use lowercase letters, numbers, and single hyphens");
	const entry = requiredString(value, "entry");
	if (isAbsolute(entry) || entry.split(/[\\/]/u).includes(".."))
		throw new Error("plugin manifest entry must be relative to the plugin root");
	return {
		apiVersion: PLUGIN_API_VERSION,
		id,
		name: requiredString(value, "name"),
		version: requiredString(value, "version"),
		entry,
		permissions: parsePermissions(value.permissions),
	};
}

export async function readPluginManifest(manifestPath: string): Promise<PluginManifest> {
	try {
		return parsePluginManifest(JSON.parse(await readFile(manifestPath, "utf8")));
	} catch (cause) {
		if (cause instanceof Error && cause.message.startsWith("plugin manifest")) throw cause;
		throw new Error("plugin manifest is not valid JSON");
	}
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
	const candidateRelative = relative(resolvedRoot, candidate);
	if (candidateRelative.startsWith("..") || candidateRelative === "")
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

export function isPluginDefinition(value: unknown): value is PluginDefinition {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly apply?: unknown };
	return typeof candidate.name === "string" && candidate.name.length > 0 && typeof candidate.apply === "function";
}

export function getPluginDefinition<Config = unknown>(module: PluginModule<Config>): PluginDefinition<Config> {
	if ("default" in module && module.default !== undefined) {
		throw new TypeError("Plugin modules must use namespace exports and cannot define a default export");
	}
	if (!isPluginDefinition(module)) {
		throw new TypeError("Plugin module must export a non-empty name and an apply function");
	}
	return module as PluginDefinition<Config>;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface CompositionEntry {
	readonly id: string;
	readonly name: string;
	readonly config?: JsonValue;
	readonly dependsOn?: readonly string[];
	readonly optionalDependsOn?: readonly string[];
	readonly required?: boolean;
	readonly disabled?: boolean;
	readonly group?: string;
}

export interface CompositionDocument {
	readonly entries?: readonly CompositionEntry[];
	readonly patches?: readonly CompositionPatch[];
}

export type CompositionPatch =
	| { readonly op: "insert" | "append"; readonly entry: CompositionEntry; readonly after?: string }
	| { readonly op: "remove" | "replace" | "enable" | "disable"; readonly id: string; readonly entry?: CompositionEntry }
	| { readonly op: "move"; readonly id: string; readonly before?: string; readonly after?: string };

export interface CompositionLayer {
	readonly name: "base" | "mode" | "user" | "project" | "explicit";
	readonly document: CompositionDocument;
}

export interface EntryRecord {
	readonly entry: CompositionEntry;
	readonly status: "pending" | "loading" | "active" | "failed" | "disabled" | "skipped";
	readonly error?: Error;
	readonly fiber?: Fiber;
}

export interface PluginInventory {
	readonly entries: readonly EntryRecord[];
	readonly get: (id: string) => EntryRecord | undefined;
}

export class CompositionError extends Error {
	readonly code: "invalid" | "duplicate" | "missing-dependency" | "cycle" | "required-failure" | "patch";
	constructor(code: CompositionError["code"], message: string) {
		super(message);
		this.name = "CompositionError";
		this.code = code;
	}
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertId(id: string, label = "entry id"): void {
	if (!identifier.test(id)) throw new CompositionError("invalid", `${label} must match ${identifier.source}`);
}
function clone<T>(value: T): T {
	return structuredClone(value);
}
function validateValue(value: unknown, path = "config"): asserts value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		if (typeof value === "string" && (value.includes("$(") || value.includes("`")))
			throw new CompositionError("invalid", `${path} contains a forbidden command expression`);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CompositionError("invalid", `${path} contains a non-finite number`);
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) validateValue(item, `${path}[${index}]`);
		return;
	}
	if (typeof value === "object") {
		for (const [key, item] of Object.entries(value)) validateValue(item, `${path}.${key}`);
		return;
	}
	throw new CompositionError("invalid", `${path} must contain JSON/YAML values`);
}
function resolveEnvironment(
	value: JsonValue,
	environment: Readonly<Record<string, string | undefined>>,
	path = "config",
): JsonValue {
	if (typeof value === "string") {
		const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
		if (!match) return value;
		const variable = match[1] ?? match[2];
		const resolved = environment[variable];
		if (resolved === undefined)
			throw new CompositionError("invalid", `${path} references missing environment variable ${variable}`);
		return resolved;
	}
	if (Array.isArray(value))
		return value.map((item, index) => resolveEnvironment(item, environment, `${path}[${index}]`));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, resolveEnvironment(item, environment, `${path}.${key}`)]),
		);
	return value;
}
function validateEntry(entry: CompositionEntry): CompositionEntry {
	if (!entry || typeof entry !== "object") throw new CompositionError("invalid", "Composition entry must be an object");
	assertId(entry.id);
	if (
		typeof entry.name !== "string" ||
		entry.name.length === 0 ||
		entry.name.includes("..") ||
		entry.name.includes("\0")
	)
		throw new CompositionError("invalid", `Invalid plugin module for ${entry.id}`);
	if (entry.config !== undefined) validateValue(entry.config, `${entry.id}.config`);
	for (const dep of [...(entry.dependsOn ?? []), ...(entry.optionalDependsOn ?? [])]) assertId(dep, "dependency id");
	if (entry.group !== undefined) assertId(entry.group, "group");
	return Object.freeze({ ...entry, config: entry.config === undefined ? undefined : clone(entry.config) });
}

function normalizeDocument(document: CompositionDocument): CompositionDocument {
	const entries = (document.entries ?? []).map(validateEntry);
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) throw new CompositionError("duplicate", `Duplicate entry id: ${entry.id}`);
		ids.add(entry.id);
	}
	return { entries, patches: document.patches ?? [] };
}

export function parseComposition(
	text: string,
	format?: "json" | "yaml",
	environment: Readonly<Record<string, string | undefined>> = process.env,
): CompositionDocument {
	let value: unknown;
	try {
		value = (format ?? "yaml") === "json" ? JSON.parse(text) : parseYaml(text);
	} catch (error) {
		throw new CompositionError(
			"invalid",
			`Invalid composition: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CompositionError("invalid", "Composition root must be an object");
	const document = value as CompositionDocument;
	return normalizeDocument({
		...document,
		entries: document.entries?.map((entry) => ({
			...entry,
			config:
				entry.config === undefined ? undefined : resolveEnvironment(entry.config, environment, `${entry.id}.config`),
		})),
	});
}

export async function readCompositionFile(filePath: string): Promise<CompositionDocument> {
	const suffix = extname(filePath).toLowerCase();
	return parseComposition(await readFile(filePath, "utf8"), suffix === ".json" ? "json" : "yaml");
}

export function applyCompositionPatch(
	entries: readonly CompositionEntry[],
	patch: CompositionPatch,
): CompositionEntry[] {
	const result = entries.map((entry) => ({ ...entry }));
	const index = (id: string): number => result.findIndex((entry) => entry.id === id);
	if (patch.op === "insert" || patch.op === "append") {
		const entry = validateEntry(patch.entry);
		if (index(entry.id) >= 0) throw new CompositionError("duplicate", `Duplicate entry id: ${entry.id}`);
		if (patch.op === "append" || patch.after === undefined) result.push(entry);
		else {
			const target = index(patch.after);
			if (target < 0) throw new CompositionError("patch", `Patch target not found: ${patch.after}`);
			result.splice(target + 1, 0, entry);
		}
		return result;
	}
	if (!("id" in patch)) throw new CompositionError("patch", `Patch ${patch.op} requires an id`);
	const target = index(patch.id);
	if (target < 0) throw new CompositionError("patch", `Patch target not found: ${patch.id}`);
	if (patch.op === "remove") result.splice(target, 1);
	else if (patch.op === "replace") {
		if (!patch.entry || patch.entry.id !== patch.id)
			throw new CompositionError("patch", "replace requires entry with matching id");
		result[target] = validateEntry(patch.entry);
	} else if (patch.op === "enable" || patch.op === "disable")
		result[target] = { ...result[target], disabled: patch.op === "disable" };
	else {
		if (patch.op !== "move") throw new CompositionError("patch", `Unsupported patch operation: ${patch.op}`);
		const [moved] = result.splice(target, 1);
		const before = patch.before === undefined ? -1 : index(patch.before);
		const after = patch.after === undefined ? -1 : index(patch.after);
		if (patch.before !== undefined && before < 0)
			throw new CompositionError("patch", `Patch target not found: ${patch.before}`);
		if (patch.after !== undefined && after < 0)
			throw new CompositionError("patch", `Patch target not found: ${patch.after}`);
		result.splice(before >= 0 ? before : after >= 0 ? after + 1 : result.length, 0, moved);
	}
	return result;
}

export function mergeCompositionLayers(layers: readonly CompositionLayer[]): readonly CompositionEntry[] {
	let entries: CompositionEntry[] = [];
	const order: Readonly<Record<CompositionLayer["name"], number>> = {
		base: 0,
		mode: 1,
		user: 2,
		project: 3,
		explicit: 4,
	};
	const orderedLayers = [...layers].sort((left, right) => order[left.name] - order[right.name]);
	for (const layer of orderedLayers) {
		const document = normalizeDocument(layer.document);
		for (const entry of document.entries ?? []) {
			const existing = entries.findIndex((item) => item.id === entry.id);
			if (existing >= 0) entries[existing] = entry;
			else entries.push(entry);
		}
		for (const patch of document.patches ?? []) entries = applyCompositionPatch(entries, patch);
	}
	return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export function topologicallySortEntries(entries: readonly CompositionEntry[]): readonly CompositionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const state = new Map<string, "visiting" | "done">();
	const sorted: CompositionEntry[] = [];
	const visit = (entry: CompositionEntry): void => {
		if (state.get(entry.id) === "done") return;
		if (state.get(entry.id) === "visiting") throw new CompositionError("cycle", `Dependency cycle at ${entry.id}`);
		state.set(entry.id, "visiting");
		for (const dependency of entry.dependsOn ?? []) {
			const target = byId.get(dependency);
			if (!target)
				throw new CompositionError("missing-dependency", `${entry.id} requires missing dependency ${dependency}`);
			visit(target);
		}
		for (const dependency of entry.optionalDependsOn ?? []) {
			const target = byId.get(dependency);
			if (target) visit(target);
		}
		state.set(entry.id, "done");
		sorted.push(entry);
	};
	for (const entry of entries) visit(entry);
	return Object.freeze(sorted);
}

export class EntryTree {
	private readonly records = new Map<string, EntryRecord>();
	constructor(entries: readonly CompositionEntry[]) {
		for (const entry of entries) this.records.set(entry.id, { entry, status: entry.disabled ? "disabled" : "pending" });
	}
	get(id: string): EntryRecord | undefined {
		return this.records.get(id);
	}
	snapshot(): PluginInventory {
		const entries = Object.freeze([...this.records.values()].map((record) => Object.freeze({ ...record })));
		return Object.freeze({ entries, get: (id: string) => entries.find((entry) => entry.entry.id === id) });
	}
	set(id: string, update: Partial<EntryRecord>): void {
		const current = this.records.get(id);
		if (current) this.records.set(id, { ...current, ...update });
	}
}

export interface LoaderOptions {
	readonly context: Context;
	readonly layers?: readonly CompositionLayer[];
	readonly entries?: readonly CompositionEntry[];
	readonly importModule?: (name: string) => Promise<PluginModule>;
}

export class CompositionLoader {
	readonly tree: EntryTree;
	private readonly fibers: Fiber[] = [];
	private readonly context: Context;
	private readonly importer: (name: string) => Promise<PluginModule>;
	constructor(options: LoaderOptions) {
		this.context = options.context;
		this.importer = options.importModule ?? ((name) => import(name));
		const entries = options.entries ?? mergeCompositionLayers(options.layers ?? []);
		this.tree = new EntryTree(entries);
	}
	async load(): Promise<PluginInventory> {
		const entries = topologicallySortEntries(this.tree.snapshot().entries.map((record) => record.entry));
		const active = new Set<string>();
		for (const entry of entries) {
			if (entry.disabled) continue;
			const required = entry.required !== false;
			const failedDependency = [...(entry.dependsOn ?? [])].find((id) => !active.has(id));
			if (failedDependency) {
				const error = new CompositionError(
					"missing-dependency",
					`${entry.id} dependency ${failedDependency} is not active`,
				);
				this.tree.set(entry.id, { status: required ? "failed" : "skipped", error });
				if (required)
					throw new CompositionError("required-failure", `Required entry ${entry.id} failed: ${error.message}`);
				continue;
			}
			this.tree.set(entry.id, { status: "loading" });
			try {
				const definition = getPluginDefinition(await this.importer(entry.name));
				const fiber = await this.context.plugin(definition, entry.config);
				this.fibers.push(fiber);
				active.add(entry.id);
				this.tree.set(entry.id, { status: "active", fiber });
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				this.tree.set(entry.id, { status: required ? "failed" : "skipped", error });
				if (required) {
					await this.dispose();
					throw new CompositionError("required-failure", `Required entry ${entry.id} failed: ${error.message}`);
				}
			}
		}
		return this.tree.snapshot();
	}
	async dispose(): Promise<void> {
		for (const fiber of [...this.fibers].reverse()) await fiber.dispose();
		this.fibers.length = 0;
	}
}

export function createCompositionLoader(options: LoaderOptions): CompositionLoader {
	return new CompositionLoader(options);
}
