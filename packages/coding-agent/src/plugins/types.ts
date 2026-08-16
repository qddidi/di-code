export const PLUGIN_API_VERSION = 1;

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

export interface PluginPermissions {
	readonly filesystem: "none" | "read-project";
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
