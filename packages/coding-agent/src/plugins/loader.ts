// Runtime plugin loader for manifest packages and explicit development entries.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { PluginFactory } from "@di-code/plugin-runtime";
import { createJiti } from "jiti";
import { PluginManager } from "./manager.ts";
import { readPackagePluginManifest, readPluginManifest, resolvePluginEntry } from "./manifest.ts";
import { type CodingAgentPluginHost, createCodingAgentPluginHost } from "./runtime-host.ts";
import type { ProjectTrustManager } from "./trust.ts";
import type { DiscoveredPlugin, PluginDiagnostic, PluginDiagnosticStage } from "./types.ts";

interface PluginCandidate {
	readonly root: string;
	readonly explicit: boolean;
	readonly entryOverride?: string;
}

/** A plugin loading transition emitted after its manifest is discovered. */
export type PluginLoadStatus =
	| { readonly state: "loading"; readonly pluginId: string }
	| { readonly state: "loaded"; readonly pluginId: string; readonly tools: number; readonly commands: number }
	| {
			readonly state: "failed";
			readonly pluginId?: string;
			readonly sourcePath: string;
			readonly stage: Extract<PluginDiagnosticStage, "manifest" | "import">;
			readonly message: string;
	  };

export interface PluginLoadOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly projectTrusted?: boolean;
	readonly trustManager?: ProjectTrustManager;
	readonly mode?: "interactive" | "print" | "json";
	readonly explicitPaths?: readonly string[];
	readonly pluginIds?: readonly string[];
	/** Observes packaged plugin import outcomes without affecting the loader. */
	readonly onPluginLoadStatus?: (status: PluginLoadStatus) => void;
}

export interface PluginLoadResult {
	readonly runtimeHost: CodingAgentPluginHost;
	readonly loaded: readonly DiscoveredPlugin[];
	readonly diagnostics: readonly PluginDiagnostic[];
}

async function isPluginPackage(root: string): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		return typeof parsed === "object" && parsed !== null && "diCode" in parsed;
	} catch {
		return false;
	}
}

async function discoverPluginRoots(cwd: string, agentDir: string, trusted: boolean): Promise<string[]> {
	const roots = [...(trusted ? [join(cwd, ".di-code", "plugins")] : []), join(agentDir, "plugins", "installed")];
	const result: string[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const pluginRoot = join(root, entry.name);
			if (existsSync(join(pluginRoot, "plugin.json")) || (await isPluginPackage(pluginRoot)))
				result.push(resolve(pluginRoot));
		}
	}
	return result.sort((a, b) => a.localeCompare(b));
}

function explicitPluginCandidates(cwd: string, paths: readonly string[]): PluginCandidate[] {
	return paths.map((path) => {
		const resolved = resolve(cwd, path);
		try {
			if (statSync(resolved).isFile()) return { root: dirname(resolved), explicit: true, entryOverride: resolved };
		} catch {
			// Let manifest/entry diagnostics report missing explicit paths consistently below.
		}
		return { root: resolved, explicit: true };
	});
}

function syntheticManifest(root: string, entry: string): Awaited<ReturnType<typeof readPluginManifest>> {
	const base = entry
		.replace(/^.*[\\/]/, "")
		.replace(/\.[^.]+$/, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	const suffix = createHash("sha256").update(root).digest("hex").slice(0, 8);
	const id = `${base || "explicit"}-${suffix}`.slice(0, 64);
	return {
		apiVersion: 1,
		id,
		name: id,
		version: "0.0.0",
		entry: relative(root, entry),
		permissions: { filesystem: "none", network: [], process: [] },
	};
}

export async function loadPlugins(options: PluginLoadOptions): Promise<PluginLoadResult> {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir ?? join(cwd, ".di-code"));
	const trusted =
		options.projectTrusted ?? (options.trustManager ? (await options.trustManager.get(cwd)) === true : false);
	const runtimeHost = createCodingAgentPluginHost({
		cwd,
		mode: options.mode ?? "json",
		projectTrusted: trusted,
		reservedCommands: ["help", "clear", "model", "session", "theme", "settings", "compact", "usage", "retry"],
	});
	const diagnostics: PluginDiagnostic[] = [];
	const enabledGlobal = new Set(
		(await new PluginManager({ agentDir }).list()).filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
	);
	const discoveredCandidates: PluginCandidate[] = (await discoverPluginRoots(cwd, agentDir, trusted)).map((root) => ({
		root,
		explicit: false,
	}));
	const explicitCandidates = explicitPluginCandidates(cwd, options.explicitPaths ?? []);
	const pluginCandidates = [...discoveredCandidates, ...explicitCandidates].filter(
		(candidate, index, all) =>
			all.findIndex((other) => other.root === candidate.root && other.entryOverride === candidate.entryOverride) ===
			index,
	);
	pluginCandidates.sort(
		(a, b) => a.root.localeCompare(b.root) || (a.entryOverride ?? "").localeCompare(b.entryOverride ?? ""),
	);
	const loaded: DiscoveredPlugin[] = [];
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	for (const candidate of pluginCandidates) {
		const { root } = candidate;
		const manifestPath = candidate.entryOverride ?? join(root, "plugin.json");
		let manifest: Awaited<ReturnType<typeof readPluginManifest>>;
		try {
			manifest = candidate.entryOverride
				? await readPluginManifest(manifestPath).catch(async () =>
						syntheticManifest(root, candidate.entryOverride as string),
					)
				: existsSync(manifestPath)
					? await readPluginManifest(manifestPath)
					: await readPackagePluginManifest(root);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			// Keep path escape failures on the historical entry-resolution diagnostic path.
			// The shared parser still rejects them before any module import occurs.
			const stage: Extract<PluginDiagnosticStage, "manifest" | "import"> = message.includes(
				"plugin manifest entry must be relative",
			)
				? "import"
				: "manifest";
			const diagnosticMessage = stage === "import" ? "plugin entry must stay inside the plugin root" : message;
			diagnostics.push({
				sourcePath: manifestPath,
				stage,
				severity: "error",
				message: diagnosticMessage,
			});
			options.onPluginLoadStatus?.({ state: "failed", sourcePath: manifestPath, stage, message: diagnosticMessage });
			continue;
		}
		const projectLocal = root.startsWith(resolve(cwd, ".di-code", "plugins"));
		if (!candidate.explicit && !projectLocal && !enabledGlobal.has(manifest.id)) continue;
		if (
			!candidate.explicit &&
			options.pluginIds !== undefined &&
			options.pluginIds.length > 0 &&
			!options.pluginIds.includes(manifest.id)
		)
			continue;
		options.onPluginLoadStatus?.({ state: "loading", pluginId: manifest.id });
		const toolCount = runtimeHost.listTools().length;
		const commandCount = runtimeHost.listCommands().length;
		try {
			const entry = candidate.entryOverride ?? (await resolvePluginEntry(root, manifest.entry));
			const module = await jiti.import<{ default?: unknown }>(entry);
			if (typeof module.default !== "function") throw new Error("plugin entry must export a default factory function");
			const factory = module.default as PluginFactory;
			await runtimeHost.load(manifest.id, factory);
			loaded.push({ manifest, root, sourcePath: manifestPath, projectLocal });
			options.onPluginLoadStatus?.({
				state: "loaded",
				pluginId: manifest.id,
				tools: runtimeHost.listTools().length - toolCount,
				commands: runtimeHost.listCommands().length - commandCount,
			});
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			diagnostics.push({
				pluginId: manifest.id,
				sourcePath: manifestPath,
				stage: "import",
				severity: "error",
				message,
			});
			options.onPluginLoadStatus?.({
				state: "failed",
				pluginId: manifest.id,
				sourcePath: manifestPath,
				stage: "import",
				message,
			});
		}
	}
	return { runtimeHost, loaded, diagnostics };
}
