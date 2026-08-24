import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type CompositionDocument,
	type CompositionEntry,
	type CompositionLayer,
	mergeCompositionLayers,
	PluginInstallManager,
	type PluginModule,
	readCompositionFile,
	resolvePackagePluginExport,
} from "@di-code/plugin-loader";

export type DefaultCompositionName = "base" | "interactive" | "print" | "json" | "rpc" | "webui";

export interface CompositionResolutionOptions {
	/** Work root used for project composition discovery and the workspace capability. */
	readonly cwd?: string;
	/** User data root containing the optional user composition document. */
	readonly agentDir?: string;
	/** Explicit JSON or YAML composition document applied last. */
	readonly compositionPath?: string;
	/** Excludes the project composition document for this invocation. */
	readonly includeProjectComposition?: boolean;
	readonly observability?: boolean;
	readonly allowedRoot?: string;
}

const observabilityEntries = [
	{ id: "plugin-profiler", name: "@di-code/builtins/plugin-profiler", dependsOn: ["runtime"] },
	{ id: "plugin-invariants", name: "@di-code/builtins/plugin-invariants", dependsOn: ["runtime"] },
	{ id: "plugin-test-runtime", name: "@di-code/builtins/plugin-test-runtime", dependsOn: ["runtime"] },
	{ id: "plugin-trace", name: "@di-code/coding-agent/plugin-trace", dependsOn: ["plugin-inventory"] },
	{
		id: "plugin-dump-composition",
		name: "@di-code/coding-agent/plugin-dump-composition",
		dependsOn: ["plugin-inventory"],
	},
] as const satisfies readonly CompositionEntry[];

function builtinCompositionPath(name: DefaultCompositionName): string {
	return fileURLToPath(new URL(`../compositions/${name}.yml`, import.meta.url));
}

/** Resolves the package-owned base plus exactly one mode document. */
export async function resolveDefaultComposition(
	name: DefaultCompositionName,
	options: { readonly observability?: boolean; readonly allowedRoot?: string } = {},
): Promise<readonly CompositionEntry[]> {
	const base = await readRequiredComposition(builtinCompositionPath("base"));
	const mode = name === "base" ? { entries: [] } : await readRequiredComposition(builtinCompositionPath(name));
	return Object.freeze(
		withWorkspaceRoot(
			mergeCompositionLayers([
				{ name: "base", document: base },
				{
					name: "mode",
					document: { entries: [...(mode.entries ?? []), ...(options.observability ? observabilityEntries : [])] },
				},
			]),
			options.allowedRoot,
		),
	);
}

function isJsonObject(
	value: CompositionEntry["config"],
): value is Readonly<Record<string, import("@di-code/plugin-loader").JsonValue>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withWorkspaceRoot(
	entries: readonly CompositionEntry[],
	allowedRoot: string | undefined,
): readonly CompositionEntry[] {
	if (allowedRoot === undefined) return entries;
	return entries.map((entry) =>
		entry.id === "workspace"
			? { ...entry, config: { ...(isJsonObject(entry.config) ? entry.config : {}), allowedRoot } }
			: entry,
	);
}

function markProjectEntries(document: CompositionDocument): CompositionDocument {
	const mark = (entry: CompositionEntry): CompositionEntry => ({ ...entry, projectLocal: true });
	return {
		...(document.entries ? { entries: document.entries.map(mark) } : {}),
		...(document.patches
			? {
					patches: document.patches.map((patch) =>
						"entry" in patch && patch.entry !== undefined ? { ...patch, entry: mark(patch.entry) } : patch,
					),
				}
			: {}),
	};
}

function isMissingFile(cause: unknown): boolean {
	return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

async function readOptionalComposition(filePath: string): Promise<CompositionDocument | undefined> {
	try {
		return await readCompositionFile(filePath);
	} catch (cause) {
		if (isMissingFile(cause)) return undefined;
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to read composition ${filePath}: ${message}`, { cause });
	}
}

async function readRequiredComposition(filePath: string): Promise<CompositionDocument> {
	try {
		return await readCompositionFile(filePath);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to read composition ${filePath}: ${message}`, { cause });
	}
}

/**
 * Resolves built-in, user, project, and explicit composition layers in their fixed precedence order.
 * Project entries are marked local so the Loader retains trust checks for entries added through project configuration.
 */
export async function resolveCompositionEntries(
	name: DefaultCompositionName,
	options: CompositionResolutionOptions = {},
): Promise<readonly CompositionEntry[]> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
	const [base, mode] = await Promise.all([
		readRequiredComposition(builtinCompositionPath("base")),
		readRequiredComposition(builtinCompositionPath(name)),
	]);
	const layers: CompositionLayer[] = [
		{ name: "base", document: base },
		{
			name: "mode",
			document: {
				entries: [...(mode.entries ?? []), ...(options.observability ? observabilityEntries : [])],
			},
		},
	];
	const userComposition = await readOptionalComposition(join(agentDir, "composition.yml"));
	if (userComposition !== undefined) layers.push({ name: "user", document: userComposition });
	if (options.includeProjectComposition !== false) {
		const projectComposition = await readOptionalComposition(join(cwd, ".di-code", "composition.yml"));
		if (projectComposition !== undefined)
			layers.push({ name: "project", document: markProjectEntries(projectComposition) });
	}
	if (options.compositionPath !== undefined) {
		layers.push({ name: "explicit", document: await readRequiredComposition(resolve(cwd, options.compositionPath)) });
	}
	return Object.freeze(withWorkspaceRoot(mergeCompositionLayers(layers), options.allowedRoot));
}

/**
 * Resolves only enabled managed plugins before the Loader receives its entry list.
 * Disabled manifests are not resolved or dynamically imported.
 */
export async function resolveManagedCompositionEntries(
	agentDir = join(homedir(), ".di-code"),
): Promise<readonly CompositionEntry[]> {
	const manager = new PluginInstallManager({ managedRoot: join(resolve(agentDir), "plugins", "installed") });
	const plugins = await manager.list();
	return await Promise.all(
		plugins
			.filter((plugin) => plugin.enabled)
			.map(async (plugin) => ({
				id: `managed.${plugin.id}`,
				name: pathToFileURL(await resolvePackagePluginExport(plugin.installedPath, plugin.manifest.entry)).href,
				dependsOn: ["Bootstrap"],
				required: false,
			})),
	);
}

/** Imports own composition entries from source in development; package exports handle published use. */
export function importCompositionModule(name: string): Promise<PluginModule> {
	switch (name) {
		case "@di-code/coding-agent/plugin-manager":
			return import("./plugin-manager.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/plugin-inventory":
			return import("./plugin-inventory.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/plugin-trace":
			return import("./plugin-trace.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/plugin-dump-composition":
			return import("./plugin-dump-composition.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/mcp-config-entry":
			return import("./mcp-config-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/mcp-client-entry":
			return import("./mcp-client-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/mcp-transport-entry":
			return import("./mcp-transport-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/mcp-tools-entry":
			return import("./mcp-tools-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/session-factory-entry":
			return import("./session-factory-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/session-store-jsonl-entry":
			return import("./session-store-jsonl-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/rpc-server-entry":
			return import("./rpc-server-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/interactive-resources-entry":
			return import("./interactive-resources-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/interactive-host-entry":
			return import("./interactive-host-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/runtime-core-entry":
			return import("./runtime-core-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/composition-loader-entry":
			return import("./composition-loader-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/project-trust-entry":
			return import("./project-trust-entry.ts") as Promise<PluginModule>;
		case "@di-code/coding-agent/rpc-client-sdk-entry":
			return import("./rpc-client-sdk-entry.ts") as Promise<PluginModule>;
		default:
			return import(name) as Promise<PluginModule>;
	}
}
