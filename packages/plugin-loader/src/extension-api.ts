import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ExtensionDisposer = () => void | Promise<void>;

export interface ExtensionApiContext {
	readonly extensionId: string;
	readonly signal: AbortSignal;
	readonly session: Record<string, never>;
	readonly files: Record<string, never>;
	readonly subprocess: Record<string, never>;
	readonly network: Record<string, never>;
	readonly subagents: Record<string, never>;
	readonly ui: Record<string, never>;
	readonly settings: Record<string, never>;
	readonly diagnostics: {
		readonly report: (input: { readonly level: string; readonly code: string; readonly message: string }) => void;
	};
	readonly sessions: Record<string, never>;
	readonly providers: Record<string, never>;
	readonly jobs: Record<string, never>;
}

export interface ExtensionCommand {
	readonly name: string;
	readonly description: string;
	readonly run: (input: unknown, options: { readonly signal: AbortSignal }) => Promise<unknown>;
}
export interface ExtensionTool {
	readonly name: string;
	readonly description: string;
	readonly schema: unknown;
	readonly execute: (input: unknown, options: { readonly signal: AbortSignal }) => Promise<unknown>;
}
export interface ExtensionProvider {
	readonly id: string;
	readonly models: readonly string[];
	readonly request: (input: unknown, options: { readonly signal: AbortSignal }) => AsyncIterable<unknown>;
}
export interface ExtensionSubagent {
	readonly name: string;
	readonly description: string;
	readonly run: (input: unknown, options: { readonly signal: AbortSignal }) => Promise<unknown>;
}
export interface ExtensionTuiOverlay {
	readonly name: string;
	readonly render: (input: unknown) => string | readonly string[];
}
export interface ExtensionWeb {
	readonly entry: string;
	readonly integrity: `sha256-${string}`;
	readonly slots: readonly string[];
}
export interface ExtensionApi {
	readonly apiVersion: 1;
	readonly ctx: ExtensionApiContext;
	readonly on: (event: string, listener: (payload: unknown) => void | Promise<void>) => ExtensionDisposer;
	readonly registerCommand: (command: ExtensionCommand) => ExtensionDisposer;
	readonly registerTool: (tool: ExtensionTool) => ExtensionDisposer;
	readonly registerProvider: (provider: ExtensionProvider) => ExtensionDisposer;
	readonly registerSubagent: (subagent: ExtensionSubagent) => ExtensionDisposer;
	readonly registerTuiOverlay: (overlay: ExtensionTuiOverlay) => ExtensionDisposer;
	readonly registerWeb: (web: ExtensionWeb) => ExtensionDisposer;
}

export interface ExtensionApiInstance extends ExtensionApi {
	readonly commands: readonly ExtensionCommand[];
	readonly tools: readonly ExtensionTool[];
	readonly providers: readonly ExtensionProvider[];
	readonly subagents: readonly ExtensionSubagent[];
	readonly tuiOverlays: readonly ExtensionTuiOverlay[];
	readonly web: readonly ExtensionWeb[];
	readonly emit: (event: string, payload: unknown) => Promise<void>;
	dispose(): Promise<void>;
}

function duplicate(kind: string, name: string): Error {
	return new Error(`Duplicate ${kind} registration: ${name}`);
}

/** Creates the one public plugin API. Every disposer is idempotent and owns its registration. */
export function createExtensionAPI(
	extensionId: string,
	options: { readonly signal?: AbortSignal; readonly context?: Partial<ExtensionApiContext> } = {},
): ExtensionApiInstance {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const events = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
	const commands: ExtensionCommand[] = [];
	const tools: ExtensionTool[] = [];
	const providers: ExtensionProvider[] = [];
	const subagents: ExtensionSubagent[] = [];
	const tuiOverlays: ExtensionTuiOverlay[] = [];
	const web: ExtensionWeb[] = [];
	let disposed = false;
	const remove = <T>(list: T[], value: T): ExtensionDisposer => {
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			const index = list.indexOf(value);
			if (index >= 0) list.splice(index, 1);
		};
	};
	const ensureOpen = (): void => {
		if (disposed) throw new Error("Extension API is disposed");
	};
	const api: ExtensionApiInstance = {
		apiVersion: 1,
		ctx: {
			extensionId,
			signal,
			session: {},
			files: {},
			subprocess: {},
			network: {},
			subagents: {},
			ui: {},
			settings: {},
			sessions: {},
			providers: {},
			jobs: {},
			diagnostics: { report: () => undefined },
			...options.context,
		},
		on: (event, listener) => {
			ensureOpen();
			const bucket = events.get(event) ?? new Set();
			bucket.add(listener);
			events.set(event, bucket);
			let removed = false;
			return () => {
				if (removed) return;
				removed = true;
				bucket.delete(listener);
				if (bucket.size === 0) events.delete(event);
			};
		},
		registerCommand: (command) => {
			ensureOpen();
			if (commands.some((item) => item.name === command.name)) throw duplicate("command", command.name);
			commands.push(command);
			return remove(commands, command);
		},
		registerTool: (tool) => {
			ensureOpen();
			if (tools.some((item) => item.name === tool.name)) throw duplicate("tool", tool.name);
			tools.push(tool);
			return remove(tools, tool);
		},
		registerProvider: (provider) => {
			ensureOpen();
			if (providers.some((item) => item.id === provider.id)) throw duplicate("provider", provider.id);
			providers.push(provider);
			return remove(providers, provider);
		},
		registerSubagent: (subagent) => {
			ensureOpen();
			if (subagents.some((item) => item.name === subagent.name)) throw duplicate("subagent", subagent.name);
			subagents.push(subagent);
			return remove(subagents, subagent);
		},
		registerTuiOverlay: (overlay) => {
			ensureOpen();
			if (tuiOverlays.some((item) => item.name === overlay.name)) throw duplicate("TUI overlay", overlay.name);
			tuiOverlays.push(overlay);
			return remove(tuiOverlays, overlay);
		},
		registerWeb: (contribution) => {
			ensureOpen();
			if (web.some((item) => item.entry === contribution.entry)) throw duplicate("web", contribution.entry);
			web.push(contribution);
			return remove(web, contribution);
		},
		emit: async (event, payload) => {
			for (const listener of [...(events.get(event) ?? [])]) {
				try {
					await listener(payload);
				} catch {
					// Event observers are isolated from one another and from the host.
				}
			}
		},
		commands,
		tools,
		providers,
		subagents,
		tuiOverlays,
		web,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			controller.abort(new Error(`Extension ${extensionId} disposed`));
			commands.length = 0;
			tools.length = 0;
			providers.length = 0;
			subagents.length = 0;
			tuiOverlays.length = 0;
			web.length = 0;
			events.clear();
		},
	};
	return api;
}

function frame(hash: ReturnType<typeof createHash>, path: string, bytes: Buffer): void {
	const pathBytes = Buffer.from(path, "utf8");
	hash.update(`${pathBytes.byteLength}:${path}\0${bytes.byteLength}:`, "utf8");
	hash.update(bytes);
}

async function collectFiles(root: string, current: string, files: string[]): Promise<void> {
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const absolute = join(current, entry.name);
		const relativePath = relative(root, absolute).replaceAll("\\", "/");
		if (entry.isSymbolicLink()) {
			const target = await realpath(absolute);
			const outside = relative(root, target);
			if (outside.startsWith("..") || outside === "")
				throw new Error(`Plugin integrity rejects symlink outside package root: ${relativePath}`);
		}
		if (entry.isDirectory()) await collectFiles(root, absolute, files);
		else if (entry.isFile()) files.push(relativePath);
		else throw new Error(`Plugin integrity rejects special file: ${relativePath}`);
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Computes the host-owned package digest using path-length-framing-v1. */
export async function computePackageIntegrity(root: string): Promise<`sha256-${string}`> {
	const resolved = await realpath(root);
	const files: string[] = [];
	await collectFiles(resolved, resolved, files);
	files.sort((left, right) => left.localeCompare(right));
	const hash = createHash("sha256");
	for (const path of files) {
		const bytes = await readFile(join(resolved, ...path.split("/")));
		if (path === "package.json") {
			const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
			delete parsed.packageIntegrity;
			if (parsed.diCode && typeof parsed.diCode === "object")
				delete (parsed.diCode as Record<string, unknown>).packageIntegrity;
			frame(hash, path, Buffer.from(canonicalJson(parsed), "utf8"));
		} else frame(hash, path, bytes);
	}
	return `sha256-${hash.digest("base64")}`;
}

export async function computeWebBundleIntegrity(source: string | URL): Promise<`sha256-${string}`> {
	const bytes =
		typeof source === "string" && !source.startsWith("http:") && !source.startsWith("https:")
			? await readFile(source)
			: Buffer.from(await (await fetch(source)).arrayBuffer());
	return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

/** Verifies registry-provided npm tarball bytes before they are trusted. */
export function validateNpmTarballIntegrity(bytes: Uint8Array, expected: string): void {
	const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (actual !== expected)
		throw new Error(`npm registry tarball integrity mismatch: expected ${expected}, got ${actual}`);
}

export function normalizePluginSource(source: string): string {
	if (source.startsWith("npm:")) throw new Error("npm source must be resolved to an exact version before trust");
	if (source.startsWith("git:")) throw new Error("git source must be resolved to a complete commit before trust");
	if (source.startsWith("https:")) {
		const url = new URL(source);
		if (url.username || url.password) throw new Error("Plugin source must not include userinfo");
		url.protocol = "https:";
		url.hostname = url.hostname.toLowerCase();
		url.hash = "";
		if (url.port === "443") url.port = "";
		return url.href;
	}
	return pathToFileURL(resolve(source)).href;
}

export async function validatePackageIntegrity(root: string, expected: string): Promise<void> {
	const actual = await computePackageIntegrity(root);
	if (actual !== expected) throw new Error(`Plugin package integrity mismatch: expected ${expected}, got ${actual}`);
}

export function isSetupModule(
	value: unknown,
): value is { readonly default: (api: ExtensionApi) => void | Promise<void> } {
	return typeof value === "object" && value !== null && "default" in value && typeof value.default === "function";
}

export async function importSetupModule(entry: string, api: ExtensionApi): Promise<void> {
	const module = await import(entry);
	if (!isSetupModule(module)) throw new TypeError("Plugin entry must export default setup(api)");
	await module.default(api);
}

export async function readPackageJson(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(await realpath(root), "package.json"), "utf8")) as Record<string, unknown>;
}

export function packageRootFromEntry(entry: string): string {
	return resolve(entry, "..");
}

export interface ExtensionTrustRecord {
	readonly version: 1;
	readonly pluginId: string;
	readonly source: string;
	readonly resolvedVersion: string;
	readonly packageIntegrity: `sha256-${string}`;
	readonly trustedAt: string;
	readonly revokedAt?: string;
}

/** Persistent trust decisions are keyed by resolved identity, never by ranges or tags. */
export class PluginTrustStore {
	private readonly filePath: string;
	constructor(filePath: string) {
		this.filePath = filePath;
	}
	private async read(): Promise<readonly ExtensionTrustRecord[]> {
		try {
			const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (
				typeof value === "object" &&
				value !== null &&
				"version" in value &&
				value.version === 1 &&
				"records" in value &&
				Array.isArray(value.records)
			)
				return value.records as ExtensionTrustRecord[];
		} catch {
			// Missing or malformed trust is equivalent to no trust.
		}
		return [];
	}
	private async write(records: readonly ExtensionTrustRecord[]): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temporary, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
		await rename(temporary, this.filePath);
	}
	async find(
		pluginId: string,
		source: string,
		resolvedVersion: string,
		packageIntegrity: `sha256-${string}`,
	): Promise<ExtensionTrustRecord | undefined> {
		return (await this.read()).find(
			(record) =>
				record.pluginId === pluginId &&
				record.source === source &&
				record.resolvedVersion === resolvedVersion &&
				record.packageIntegrity === packageIntegrity &&
				record.revokedAt === undefined,
		);
	}
	async trust(
		input: Omit<ExtensionTrustRecord, "version" | "trustedAt" | "revokedAt">,
		now = new Date(),
	): Promise<ExtensionTrustRecord> {
		const record: ExtensionTrustRecord = { version: 1, ...input, trustedAt: now.toISOString() };
		const records = (await this.read()).filter(
			(item) =>
				!(
					item.pluginId === input.pluginId &&
					item.source === input.source &&
					item.resolvedVersion === input.resolvedVersion &&
					item.packageIntegrity === input.packageIntegrity
				),
		);
		await this.write([...records, record]);
		return record;
	}
	async revoke(pluginId: string, source?: string): Promise<void> {
		const now = new Date().toISOString();
		const records = (await this.read()).map((record) =>
			record.pluginId === pluginId &&
			(source === undefined || record.source === source) &&
			record.revokedAt === undefined
				? { ...record, revokedAt: now }
				: record,
		);
		await this.write(records);
	}
	async list(): Promise<readonly ExtensionTrustRecord[]> {
		return this.read();
	}
}
