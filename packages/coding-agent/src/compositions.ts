import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export type DefaultCompositionName = "base" | "interactive" | "print" | "json" | "rpc";

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

const baseEntries = [
	{ id: "Bootstrap", name: "@di-code/builtins/bootstrap" },
	{ id: "command-core", name: "@di-code/builtins/command-core", dependsOn: ["Bootstrap"] },
	{ id: "cli-parser", name: "@di-code/builtins/cli-parser", dependsOn: ["command-core"] },
	{ id: "runtime", name: "@di-code/builtins/runtime", dependsOn: ["Bootstrap"] },
	{ id: "diagnostics", name: "@di-code/builtins/diagnostics", dependsOn: ["runtime"] },
	{ id: "process-exit", name: "@di-code/builtins/process-exit", dependsOn: ["runtime"] },
	{ id: "plugin-manager", name: "@di-code/coding-agent/plugin-manager", dependsOn: ["command-core"] },
	{ id: "plugin-inventory", name: "@di-code/coding-agent/plugin-inventory", dependsOn: ["runtime"] },
	{ id: "provider-registry", name: "@di-code/builtins/provider-registry" },
	{ id: "model-catalog", name: "@di-code/builtins/model-catalog", dependsOn: ["provider-registry"] },
	{ id: "credential-env", name: "@di-code/builtins/credential-env", dependsOn: ["provider-registry"] },
	{ id: "runtime-selection", name: "@di-code/builtins/runtime-selection", dependsOn: ["provider-registry"] },
	{ id: "provider-faux", name: "@di-code/builtins/provider-faux", dependsOn: ["provider-registry"] },
	{
		id: "provider-openai",
		name: "@di-code/builtins/provider-openai",
		dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
		required: false,
	},
	{
		id: "provider-anthropic",
		name: "@di-code/builtins/provider-anthropic",
		dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
		required: false,
	},
	{
		id: "provider-deepseek",
		name: "@di-code/builtins/provider-deepseek",
		dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
		required: false,
	},
	{
		id: "provider-kimi",
		name: "@di-code/builtins/provider-kimi",
		dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
		required: false,
	},
	{
		id: "provider-zhipu",
		name: "@di-code/builtins/provider-zhipu",
		dependsOn: ["provider-registry", "runtime-selection", "credential-env"],
		required: false,
	},
	{
		id: "provider-onboarding",
		name: "@di-code/builtins/provider-onboarding",
		dependsOn: ["provider-registry", "credential-env"],
		required: false,
	},
	{ id: "session-memory", name: "@di-code/builtins/session-memory", dependsOn: ["runtime"] },
	{ id: "tool-registry", name: "@di-code/builtins/tool-registry", dependsOn: ["runtime"] },
	{ id: "workspace", name: "@di-code/builtins/workspace", dependsOn: ["tool-registry"] },
	{ id: "process", name: "@di-code/builtins/process", dependsOn: ["tool-registry"] },
	{ id: "network", name: "@di-code/builtins/network", dependsOn: ["tool-registry"] },
	{ id: "tool-approval", name: "@di-code/builtins/tool-approval", dependsOn: ["tool-registry"] },
	{ id: "tool-policy", name: "@di-code/builtins/tool-policy", dependsOn: ["tool-registry"] },
	{ id: "tool-output", name: "@di-code/builtins/tool-output", dependsOn: ["tool-registry"] },
	{ id: "tool-read", name: "@di-code/builtins/tool-read", dependsOn: ["tool-registry", "workspace"] },
	{ id: "tool-write", name: "@di-code/builtins/tool-write", dependsOn: ["tool-registry", "workspace"] },
	{ id: "tool-edit", name: "@di-code/builtins/tool-edit", dependsOn: ["tool-registry", "workspace"] },
	{ id: "tool-bash", name: "@di-code/builtins/tool-bash", dependsOn: ["tool-registry", "workspace"] },
	{ id: "tool-glob", name: "@di-code/builtins/tool-glob", dependsOn: ["tool-registry", "workspace"] },
	{ id: "tool-grep", name: "@di-code/builtins/tool-grep", dependsOn: ["tool-registry", "workspace"] },
	{ id: "tool-load-skill", name: "@di-code/builtins/tool-load-skill", dependsOn: ["tool-registry", "workspace"] },
	{ id: "session-store-jsonl", name: "@di-code/builtins/session-store-jsonl", dependsOn: ["runtime"] },
	{ id: "session-tree", name: "@di-code/builtins/session-tree", dependsOn: ["session-store-jsonl"] },
	{ id: "session-query", name: "@di-code/builtins/session-query", dependsOn: ["session-store-jsonl"] },
	{ id: "usage-meter", name: "@di-code/builtins/usage-meter", dependsOn: ["runtime"] },
	{ id: "context-budget", name: "@di-code/builtins/context-budget", dependsOn: ["runtime"] },
	{ id: "compaction-basic", name: "@di-code/builtins/compaction-basic", dependsOn: ["context-budget"] },
	{ id: "system-prompt", name: "@di-code/builtins/system-prompt", dependsOn: ["runtime"] },
	{ id: "resource-loader", name: "@di-code/builtins/resource-loader", dependsOn: ["runtime"] },
	{ id: "skills", name: "@di-code/builtins/skills", dependsOn: ["resource-loader"] },
	{ id: "mcp-config", name: "@di-code/coding-agent/mcp-config-entry", dependsOn: ["runtime"] },
	{ id: "mcp-client", name: "@di-code/coding-agent/mcp-client-entry", dependsOn: ["mcp-config"] },
	{ id: "mcp-tools", name: "@di-code/coding-agent/mcp-tools-entry", dependsOn: ["mcp-config", "mcp-client"] },
] as const satisfies readonly CompositionEntry[];

const agentLoopEntry = {
	id: "agent-loop",
	name: "@di-code/builtins/agent-loop",
	dependsOn: [
		"runtime-selection",
		"provider-faux",
		"session-memory",
		"tool-registry",
		"workspace",
		"process",
		"network",
		"tool-approval",
		"tool-policy",
		"tool-output",
	],
} as const satisfies CompositionEntry;

export const defaultCompositions: Readonly<Record<DefaultCompositionName, readonly CompositionEntry[]>> = {
	base: baseEntries,
	interactive: [
		{
			id: "agent-session",
			name: "@di-code/builtins/agent-session",
			dependsOn: ["provider-registry", "tool-registry", "context-budget", "system-prompt", "compaction-basic"],
		},
		{ id: "command-session", name: "@di-code/builtins/command-session", dependsOn: ["command-core"] },
		{ id: "command-model", name: "@di-code/builtins/command-model", dependsOn: ["command-core"] },
		{ id: "command-settings", name: "@di-code/builtins/command-settings", dependsOn: ["command-core"] },
		{ id: "command-compact", name: "@di-code/builtins/command-compact", dependsOn: ["command-core"] },
		{ id: "command-interactive-core", name: "@di-code/builtins/command-interactive-core", dependsOn: ["command-core"] },
		{ id: "theme", name: "@di-code/builtins/theme", dependsOn: ["command-core"] },
		{ id: "interactive-context", name: "@di-code/builtins/interactive-context", dependsOn: ["command-core"] },
		{ id: "tui-renderer", name: "@di-code/builtins/tui-renderer", dependsOn: ["command-core"] },
		{ id: "mode-interactive", name: "@di-code/builtins/mode-interactive", dependsOn: ["command-core"] },
	],
	print: [
		agentLoopEntry,
		{ id: "mode-print", name: "@di-code/builtins/mode-print", dependsOn: ["Bootstrap", "command-core", "agent-loop"] },
	],
	json: [
		agentLoopEntry,
		{ id: "output-json", name: "@di-code/builtins/output-json", dependsOn: ["command-core"] },
		{ id: "mode-json", name: "@di-code/builtins/mode-json", dependsOn: ["command-core", "agent-loop"] },
	],
	rpc: [
		{
			id: "agent-session",
			name: "@di-code/builtins/agent-session",
			dependsOn: ["provider-registry", "tool-registry", "system-prompt", "compaction-basic"],
		},
		{ id: "rpc-protocol-v1", name: "@di-code/builtins/rpc-protocol-v1", dependsOn: ["agent-session"] },
		{ id: "rpc-server", name: "@di-code/builtins/rpc-server", dependsOn: ["rpc-protocol-v1", "agent-session"] },
		{ id: "rpc-events", name: "@di-code/builtins/rpc-events", dependsOn: ["rpc-server"] },
	],
};

const observabilityEntries = [
	{ id: "plugin-trace", name: "@di-code/coding-agent/plugin-trace", dependsOn: ["plugin-inventory"] },
	{
		id: "plugin-dump-composition",
		name: "@di-code/coding-agent/plugin-dump-composition",
		dependsOn: ["plugin-inventory"],
	},
] as const satisfies readonly CompositionEntry[];

/** Resolves the production base plus exactly one mode, with opt-in development observability. */
export function resolveDefaultComposition(
	name: DefaultCompositionName,
	options: { readonly observability?: boolean; readonly allowedRoot?: string } = {},
): readonly CompositionEntry[] {
	const entries = [
		...defaultCompositions.base,
		...defaultCompositions[name],
		...(options.observability ? observabilityEntries : []),
	].map((entry) =>
		entry.id === "workspace" && options.allowedRoot !== undefined
			? { ...entry, config: { allowedRoot: options.allowedRoot } }
			: entry,
	);
	return Object.freeze(entries);
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
	const layers: CompositionLayer[] = [
		{ name: "base", document: { entries: defaultCompositions.base } },
		{
			name: "mode",
			document: {
				entries: [...defaultCompositions[name], ...(options.observability ? observabilityEntries : [])],
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
		case "@di-code/coding-agent/mcp-tools-entry":
			return import("./mcp-tools-entry.ts") as Promise<PluginModule>;
		default:
			return import(name) as Promise<PluginModule>;
	}
}
