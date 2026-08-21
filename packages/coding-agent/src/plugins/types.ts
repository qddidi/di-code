import type { PluginManifest } from "@di-code/plugin-runtime";

export { PLUGIN_API_VERSION } from "@di-code/plugin-runtime";

export type PluginDiagnosticStage =
	| "discover"
	| "manifest"
	| "compatibility"
	| "trust"
	| "import"
	| "factory"
	| "register"
	| "handler"
	| "install";

export interface PluginDiagnostic {
	readonly pluginId?: string;
	readonly sourcePath: string;
	readonly stage: PluginDiagnosticStage;
	readonly severity: "warning" | "error";
	readonly message: string;
}

export type { PluginManifest, PluginPermissions } from "@di-code/plugin-runtime";

export interface DiscoveredPlugin {
	readonly manifest: PluginManifest;
	readonly root: string;
	readonly sourcePath: string;
	readonly projectLocal: boolean;
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
	readonly plugins: Record<string, ManagedPlugin>;
}
