import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { type ExtensionHost, loadExtensions } from "../extensions/runtime.ts";
import type { ProjectTrustManager } from "../extensions/trust.ts";
import type { ExtensionFactory } from "../extensions/types.ts";
import { PluginManager } from "./manager.ts";
import { readPackagePluginManifest, readPluginManifest, resolvePluginEntry } from "./manifest.ts";
import type { DiscoveredPlugin, PluginDiagnostic } from "./types.ts";

export interface PluginLoadOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly projectTrusted?: boolean;
	readonly trustManager?: ProjectTrustManager;
	readonly mode?: "interactive" | "print" | "json";
	readonly explicitPaths?: readonly string[];
}

export interface PluginLoadResult {
	readonly host: ExtensionHost;
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

export async function loadPlugins(options: PluginLoadOptions): Promise<PluginLoadResult> {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir ?? join(cwd, ".di-code"));
	const trusted =
		options.projectTrusted ?? (options.trustManager ? (await options.trustManager.get(cwd)) === true : false);
	const extensionResult = await loadExtensions({
		cwd,
		projectTrusted: trusted,
		trustManager: options.trustManager,
		mode: options.mode,
		paths: options.explicitPaths,
	});
	const diagnostics: PluginDiagnostic[] = extensionResult.diagnostics.map((diagnostic) => ({
		sourcePath: diagnostic.path,
		stage: diagnostic.stage,
		severity: "error",
		message: diagnostic.message,
	}));
	const enabledGlobal = new Set(
		(await new PluginManager({ agentDir }).list()).filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
	);
	const pluginRoots = await discoverPluginRoots(cwd, agentDir, trusted);
	const loaded: DiscoveredPlugin[] = [];
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	for (const root of pluginRoots) {
		const manifestPath = join(root, "plugin.json");
		let manifest: Awaited<ReturnType<typeof readPluginManifest>>;
		try {
			manifest = await readPluginManifest(manifestPath).catch(async () => readPackagePluginManifest(root));
		} catch (cause) {
			diagnostics.push({
				sourcePath: manifestPath,
				stage: "manifest",
				severity: "error",
				message: cause instanceof Error ? cause.message : String(cause),
			});
			continue;
		}
		const projectLocal = root.startsWith(resolve(cwd, ".di-code", "plugins"));
		if (!projectLocal && !enabledGlobal.has(manifest.id)) continue;
		try {
			const entry = await resolvePluginEntry(root, manifest.entry);
			const module = await jiti.import<{ default?: unknown }>(entry);
			if (typeof module.default !== "function") throw new Error("plugin entry must export a default factory function");
			await extensionResult.host.registerExtension(entry, module.default as ExtensionFactory, manifest.id);
			loaded.push({ manifest, root, sourcePath: manifestPath, projectLocal });
		} catch (cause) {
			diagnostics.push({
				pluginId: manifest.id,
				sourcePath: manifestPath,
				stage: "import",
				severity: "error",
				message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
	return { host: extensionResult.host, loaded, diagnostics };
}
