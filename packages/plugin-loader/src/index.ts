import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	type Context,
	type Fiber,
	type PluginDefinition,
	validateWebManifest,
	type WebManifest,
} from "@di-code/plugin-runtime";
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
	readonly capabilities: PluginCapabilities;
	/** Optional declaration-only Web contributions. The browser never imports this package entry. */
	readonly web?: WebManifest;
}

export type PluginCapability = "filesystem" | "network" | "process" | "ui" | "credentials";
export type PluginCapabilities = Readonly<Partial<Record<PluginCapability, boolean>>>;

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

function parseCapabilities(value: unknown): PluginCapabilities {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("plugin manifest capabilities must be an object");
	const allowed: readonly PluginCapability[] = ["filesystem", "network", "process", "ui", "credentials"];
	for (const [key, enabled] of Object.entries(value)) {
		if (!allowed.includes(key as PluginCapability) || typeof enabled !== "boolean")
			throw new Error(`plugin manifest capability ${key} is invalid`);
	}
	return Object.freeze({ ...value }) as PluginCapabilities;
}

/** Validates package metadata before its namespace entry is imported. */
function parsePackagePluginManifest(value: unknown): PluginManifest {
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
		capabilities: parseCapabilities(value.capabilities),
		...(value.web === undefined
			? {}
			: validateWebManifest(value.web)
				? { web: value.web }
				: (() => {
						throw new Error("plugin manifest web declaration is invalid");
					})()),
	};
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
	const exportsValue = packageJson.exports;
	if (!isRecord(exportsValue) || !Object.hasOwn(exportsValue, entries[0]))
		throw new Error(`plugin package export ${entries[0]} is not declared`);
	return parsePackagePluginManifest({
		apiVersion: diCode.apiVersion,
		id: typeof packageJson.name === "string" ? packageJson.name.replace(/^@[^/]+\//, "") : "package-plugin",
		name: packageJson.name,
		version: packageJson.version,
		entry: entries[0],
		permissions: diCode.permissions ?? { filesystem: "none", network: [], process: [] },
		capabilities: diCode.capabilities,
		web: diCode.web,
	});
}

/** Verifies a managed Web bundle declaration before it can be installed. */
export async function verifyWebBundle(root: string, manifest: PluginManifest): Promise<void> {
	const bundle = manifest.web?.bundle;
	if (!bundle || bundle.source !== "managed") return;
	if (!bundle.path || !bundle.sha256 || !bundle.csp)
		throw new Error("managed Web bundle requires path, sha256, and csp");
	const target = resolve(root, bundle.path);
	if (relative(resolve(root), target).startsWith("..") || isAbsolute(relative(resolve(root), target)))
		throw new Error("Web bundle path must stay inside the plugin root");
	const bytes = await readFile(target);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== bundle.sha256) throw new Error("Web bundle sha256 does not match manifest");
	if (!bundle.csp.includes("default-src 'self'")) throw new Error("Web bundle CSP must include default-src 'self'");
}

function exportTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return undefined;
	for (const key of ["import", "node", "default"]) {
		const target = exportTarget(value[key]);
		if (target !== undefined) return target;
	}
	return undefined;
}

/** Resolves a declared package export and rejects targets outside the package root. */
export async function resolvePackagePluginExport(root: string, exportName: string): Promise<string> {
	if (!/^\.\/[A-Za-z0-9._/-]+$/u.test(exportName) || exportName.includes(".."))
		throw new Error("plugin package export name is unsafe");
	const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
	const exportsValue = packageJson.exports;
	if (!isRecord(exportsValue) || !Object.hasOwn(exportsValue, exportName))
		throw new Error(`plugin package export ${exportName} is not declared`);
	const target = exportTarget(exportsValue[exportName]);
	if (!target || isAbsolute(target) || target.split(/[\\/]/u).includes(".."))
		throw new Error("plugin package export target must stay inside the package root");
	return resolvePluginEntry(root, target, false);
}

export async function resolvePluginEntry(root: string, entry: string, checkPackageExports = true): Promise<string> {
	const resolvedRoot = await realpath(root);
	let candidate: string;
	let packageJson: Record<string, unknown> | undefined;
	try {
		packageJson = JSON.parse(await readFile(join(resolvedRoot, "package.json"), "utf8")) as Record<string, unknown>;
	} catch {
		// Fall through to manifest-relative resolution.
	}
	const exportsValue = packageJson?.exports;
	if (checkPackageExports && isRecord(exportsValue) && Object.hasOwn(exportsValue, entry))
		return resolvePackagePluginExport(resolvedRoot, entry);
	candidate = resolve(resolvedRoot, entry);
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

export function isPluginDefinition(value: unknown): value is PluginDefinition {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly apply?: unknown };
	return typeof candidate.name === "string" && candidate.name.length > 0 && typeof candidate.apply === "function";
}

export function getPluginDefinition<Config = unknown>(module: PluginModule<Config>): PluginDefinition<Config> {
	if ("default" in module) {
		throw new TypeError("Plugin modules must use namespace exports and cannot define a default export");
	}
	const candidate = unwrapPluginModule(module);
	if (candidate.apiVersion !== undefined && candidate.apiVersion !== PLUGIN_API_VERSION)
		throw new TypeError(`Plugin API version must be ${PLUGIN_API_VERSION}`);
	if (
		!isPluginDefinition(candidate) ||
		(candidate.version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate.version)) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate.name)
	) {
		throw new TypeError("Plugin module must export a non-empty name and an apply function");
	}
	return candidate as PluginDefinition<Config>;
}

/** Unwraps a namespace module's optional named `plugin` object without accepting default exports. */
export function unwrapPluginModule<Config = unknown>(module: PluginModule<Config>): PluginDefinition<Config> {
	if ("default" in module)
		throw new TypeError("Plugin modules must use namespace exports and cannot define a default export");
	const nested = module.plugin;
	return isRecord(nested)
		? (nested as unknown as PluginDefinition<Config>)
		: (module as unknown as PluginDefinition<Config>);
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
	readonly projectLocal?: boolean;
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
	readonly projectTrusted?: boolean;
}

export class CompositionLoader {
	readonly tree: EntryTree;
	private readonly fibers: Fiber[] = [];
	private readonly context: Context;
	private readonly importer: (name: string) => Promise<PluginModule>;
	private projectTrusted: boolean | undefined;
	constructor(options: LoaderOptions) {
		this.context = options.context;
		this.importer = options.importModule ?? ((name) => import(name));
		this.projectTrusted = options.projectTrusted;
		const entries = options.entries ?? mergeCompositionLayers(options.layers ?? []);
		this.tree = new EntryTree(entries);
	}
	async load(): Promise<PluginInventory> {
		const entries = topologicallySortEntries(this.tree.snapshot().entries.map((record) => record.entry));
		const active = new Set<string>();
		for (const entry of entries) {
			if (entry.disabled) continue;
			if (entry.projectLocal && this.projectTrusted === false) {
				this.tree.set(entry.id, { status: "skipped", error: new Error("Project is not trusted") });
				continue;
			}
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
	/** Loads project-local entries that were skipped before an explicit trust decision. */
	async loadTrustedProjectEntries(): Promise<PluginInventory> {
		if (this.projectTrusted === true) return this.tree.snapshot();
		this.projectTrusted = true;
		const entries = topologicallySortEntries(this.tree.snapshot().entries.map((record) => record.entry));
		const active = new Set(
			this.tree
				.snapshot()
				.entries.filter((record) => record.status === "active")
				.map((record) => record.entry.id),
		);
		for (const entry of entries) {
			const record = this.tree.get(entry.id);
			if (!entry.projectLocal || record?.status !== "skipped" || record.error?.message !== "Project is not trusted")
				continue;
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
			this.tree.set(entry.id, { status: "loading", error: undefined });
			try {
				const definition = getPluginDefinition(await this.importer(entry.name));
				const fiber = await this.context.plugin(definition, entry.config);
				this.fibers.push(fiber);
				active.add(entry.id);
				this.tree.set(entry.id, { status: "active", fiber });
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				this.tree.set(entry.id, { status: required ? "failed" : "skipped", error });
				if (required)
					throw new CompositionError("required-failure", `Required entry ${entry.id} failed: ${error.message}`);
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

export interface ProjectTrustRecord {
	readonly version: 1;
	readonly projects: Readonly<Record<string, boolean>>;
}

/** Versioned, user-owned project trust decisions. Trust controls import eligibility only. */
export class ProjectTrustStore {
	private readonly filePath: string;
	constructor(filePath: string) {
		this.filePath = filePath;
	}
	async get(projectRoot: string): Promise<boolean | null> {
		const registry = await this.read();
		const key = await canonicalPath(projectRoot);
		return registry.projects[key] === undefined ? null : registry.projects[key];
	}
	async set(projectRoot: string, trusted: boolean): Promise<void> {
		const registry = await this.read();
		const key = await canonicalPath(projectRoot);
		await this.write({ version: 1, projects: { ...registry.projects, [key]: trusted } });
	}
	private async read(): Promise<ProjectTrustRecord> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.projects))
				return { version: 1, projects: { ...parsed.projects } as Record<string, boolean> };
		} catch {
			// Missing or malformed trust files are treated as no decision.
		}
		return { version: 1, projects: {} };
	}
	private async write(value: ProjectTrustRecord): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await rename(temporary, this.filePath);
	}
}

async function canonicalPath(value: string): Promise<string> {
	try {
		return await realpath(value);
	} catch {
		return resolve(value);
	}
}

export interface ManagedPlugin {
	readonly id: string;
	readonly source: string;
	readonly installedPath: string;
	readonly enabled: boolean;
	readonly installedAt: string;
	readonly manifest: PluginManifest;
}

export interface PluginRegistry {
	readonly version: 1;
	readonly plugins: Readonly<Record<string, ManagedPlugin>>;
}

export function assertManagedPath(target: string, managedRoot: string): void {
	const child = relative(resolve(managedRoot), resolve(target));
	if (!child || child.startsWith("..") || isAbsolute(child))
		throw new Error("plugin path is outside the managed install directory");
}

export interface PluginInstallManagerOptions {
	readonly managedRoot: string;
	readonly registryPath?: string;
	readonly now?: () => Date;
	/** Maximum time a mutating operation waits for another process to release the registry lock. */
	readonly lockTimeoutMs?: number;
	/** Polling interval while waiting for the registry lock. */
	readonly lockRetryMs?: number;
	/** Lock age after which a crashed owner is assumed and its lock is recovered. */
	readonly staleLockMs?: number;
}

/** Installs local/npm/git packages through staging, rollback, and a process-shared registry lock. */
export class PluginInstallManager {
	private readonly managedRoot: string;
	private readonly registryPath: string;
	private readonly registryLockPath: string;
	private readonly registryRecoveryLockPath: string;
	private readonly now: () => Date;
	private readonly lockTimeoutMs: number;
	private readonly lockRetryMs: number;
	private readonly staleLockMs: number;
	constructor(options: PluginInstallManagerOptions) {
		this.managedRoot = resolve(options.managedRoot);
		this.registryPath = resolve(options.registryPath ?? join(this.managedRoot, "registry.json"));
		this.registryLockPath = `${this.registryPath}.lock`;
		this.registryRecoveryLockPath = `${this.registryLockPath}.recovery`;
		this.now = options.now ?? (() => new Date());
		this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
		this.lockRetryMs = options.lockRetryMs ?? 50;
		this.staleLockMs = options.staleLockMs ?? 5 * 60_000;
		for (const [name, value] of [
			["lockTimeoutMs", this.lockTimeoutMs],
			["lockRetryMs", this.lockRetryMs],
			["staleLockMs", this.staleLockMs],
		] as const) {
			if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
		}
	}
	async list(): Promise<readonly ManagedPlugin[]> {
		return Object.values((await this.readRegistry()).plugins).sort((left, right) => left.id.localeCompare(right.id));
	}
	async enable(id: string): Promise<ManagedPlugin> {
		return this.setEnabled(id, true);
	}
	async disable(id: string): Promise<ManagedPlugin> {
		return this.setEnabled(id, false);
	}
	async remove(id: string): Promise<void> {
		await this.withRegistryLock(async () => {
			const registry = await this.readRegistry();
			const plugin = registry.plugins[id];
			if (!plugin) throw new Error(`Unknown plugin: ${id}`);
			assertManagedPath(plugin.installedPath, this.managedRoot);
			const backup = resolve(this.managedRoot, `.backup-remove-${id}-${process.pid}-${Date.now()}`);
			assertManagedPath(backup, this.managedRoot);
			await rename(plugin.installedPath, backup);
			try {
				const { [id]: _removed, ...plugins } = registry.plugins;
				await this.writeRegistry({ version: 1, plugins });
				await rm(backup, { recursive: true, force: true });
			} catch (error) {
				await rename(backup, plugin.installedPath).catch(() => undefined);
				throw error;
			}
		});
	}
	async installLocal(sourcePath: string): Promise<ManagedPlugin> {
		return await this.withRegistryLock(
			async () => await this.installFromRoot(resolve(sourcePath), resolve(sourcePath)),
		);
	}
	async install(source: string): Promise<ManagedPlugin> {
		if (!source.startsWith("npm:") && !source.startsWith("git:")) return this.installLocal(source);
		await mkdir(this.managedRoot, { recursive: true });
		const staging = resolve(this.managedRoot, `.staging-${process.pid}-${Date.now()}`);
		await mkdir(staging, { recursive: true });
		try {
			if (source.startsWith("npm:")) {
				const spec = source.slice(4);
				await runExternal("npm", ["install", "--ignore-scripts", "--prefix", staging, spec], this.managedRoot);
				const packageNamePart = spec.split("@")[0];
				if (!packageNamePart) throw new Error("npm plugin specifier is missing a package name");
				const packageName = spec.startsWith("@") ? spec.slice(1).split("@")[0]?.replace("/", "@@") : packageNamePart;
				if (!packageName) throw new Error("npm plugin specifier is missing a package name");
				const sourceRoot = packageName.includes("@@")
					? join(staging, "node_modules", `@${packageName.replace("@@", "/")}`)
					: join(staging, "node_modules", packageName);
				return await this.withRegistryLock(async () => await this.installFromRoot(sourceRoot, source, staging));
			}
			await rm(staging, { recursive: true, force: true });
			await runExternal("git", ["clone", "--depth", "1", source.slice(4), staging], this.managedRoot);
			return await this.withRegistryLock(async () => await this.installFromRoot(staging, source, staging));
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}
	private async installFromRoot(sourceRoot: string, source: string, temporaryRoot?: string): Promise<ManagedPlugin> {
		const manifest = await readPackagePluginManifest(sourceRoot);
		await verifyWebBundle(sourceRoot, manifest);
		await resolvePackagePluginExport(sourceRoot, manifest.entry);
		const destination = resolve(this.managedRoot, manifest.id);
		assertManagedPath(destination, this.managedRoot);
		const staging = temporaryRoot ?? resolve(this.managedRoot, `.staging-${process.pid}-${Date.now()}`);
		const stagedPlugin = resolve(staging, manifest.id);
		assertManagedPath(stagedPlugin, staging);
		if (!temporaryRoot) await mkdir(staging, { recursive: true });
		await rm(stagedPlugin, { recursive: true, force: true });
		await cp(sourceRoot, stagedPlugin, { recursive: true });
		const backup = resolve(this.managedRoot, `.backup-${manifest.id}-${process.pid}-${Date.now()}`);
		let movedOld = false;
		try {
			if (await exists(destination)) {
				await rename(destination, backup);
				movedOld = true;
			}
			await rename(stagedPlugin, destination);
			const plugin: ManagedPlugin = {
				id: manifest.id,
				source,
				installedPath: destination,
				enabled: true,
				installedAt: this.now().toISOString(),
				manifest,
			};
			const registry = await this.readRegistry();
			await this.writeRegistry({ version: 1, plugins: { ...registry.plugins, [plugin.id]: plugin } });
			if (movedOld) await rm(backup, { recursive: true, force: true });
			return plugin;
		} catch (error) {
			await rm(destination, { recursive: true, force: true });
			if (movedOld) await rename(backup, destination).catch(() => undefined);
			throw error;
		} finally {
			if (!temporaryRoot) await rm(staging, { recursive: true, force: true });
		}
	}
	private async setEnabled(id: string, enabled: boolean): Promise<ManagedPlugin> {
		return await this.withRegistryLock(async () => {
			const registry = await this.readRegistry();
			const plugin = registry.plugins[id];
			if (!plugin) throw new Error(`Unknown plugin: ${id}`);
			const next = { ...plugin, enabled };
			await this.writeRegistry({ version: 1, plugins: { ...registry.plugins, [id]: next } });
			return next;
		});
	}
	private async withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
		const deadline = Date.now() + this.lockTimeoutMs;
		await mkdir(dirname(this.registryLockPath), { recursive: true });
		for (;;) {
			try {
				await mkdir(this.registryLockPath);
				break;
			} catch (cause) {
				if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause;
				if (await this.recoverStaleRegistryLock()) continue;
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for plugin registry lock: ${this.registryPath}`);
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, this.lockRetryMs));
			}
		}
		try {
			await writeFile(
				join(this.registryLockPath, "owner.json"),
				`${JSON.stringify({ pid: process.pid, acquiredAt: this.now().toISOString() })}\n`,
				"utf8",
			);
			return await operation();
		} finally {
			await rm(this.registryLockPath, { recursive: true, force: true });
		}
	}
	private async recoverStaleRegistryLock(): Promise<boolean> {
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(this.registryLockPath);
		} catch {
			return true;
		}
		if (Date.now() - metadata.mtimeMs <= this.staleLockMs) return false;
		try {
			await mkdir(this.registryRecoveryLockPath);
		} catch (cause) {
			if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST") return false;
			throw cause;
		}
		try {
			let confirmed: Awaited<ReturnType<typeof lstat>>;
			try {
				confirmed = await lstat(this.registryLockPath);
			} catch {
				return true;
			}
			if (Date.now() - confirmed.mtimeMs <= this.staleLockMs) return false;
			await rm(this.registryLockPath, { recursive: true, force: true });
			return true;
		} finally {
			await rm(this.registryRecoveryLockPath, { recursive: true, force: true });
		}
	}
	private async readRegistry(): Promise<PluginRegistry> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
			if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.plugins))
				return { version: 1, plugins: { ...parsed.plugins } as Record<string, ManagedPlugin> };
		} catch {
			// Missing or malformed registry starts empty.
		}
		return { version: 1, plugins: {} };
	}
	private async writeRegistry(registry: PluginRegistry): Promise<void> {
		await mkdir(dirname(this.registryPath), { recursive: true });
		const temporary = `${this.registryPath}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
		await rename(temporary, this.registryPath);
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function runExternal(command: string, args: readonly string[], cwd: string): Promise<void> {
	await new Promise<void>((resolveResult, reject) => {
		const child = spawn(command, [...args], { cwd, stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? resolveResult() : reject(new Error(`${command} plugin install failed`)),
		);
	});
}
