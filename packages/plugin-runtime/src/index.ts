// biome-ignore-all lint/suspicious/noConfusingVoidType: synchronous and asynchronous apply functions may omit a disposer.
/** A cleanup callback owned by the registering Fiber. */
export type Disposer = () => void | Promise<void>;

/** A typed, opaque key used to access a service from a Context. */
export type ServiceKey<T> = symbol & { readonly __serviceType?: T };

export function createServiceKey<T>(description: string): ServiceKey<T> {
	return Symbol(description) as ServiceKey<T>;
}

export type RuntimeMode = "interactive" | "print" | "json" | "rpc" | "test";

export type PluginStatus = "pending" | "loading" | "active" | "failed" | "unloading" | "disposed";

export function isPluginStatus(value: unknown): value is PluginStatus {
	return (
		value === "pending" ||
		value === "loading" ||
		value === "active" ||
		value === "failed" ||
		value === "unloading" ||
		value === "disposed"
	);
}

export function isRuntimeMode(value: unknown): value is RuntimeMode {
	return value === "interactive" || value === "print" || value === "json" || value === "rpc" || value === "test";
}

export interface PluginCapabilities {
	readonly filesystem?: boolean;
	readonly network?: boolean;
	readonly process?: boolean;
	readonly ui?: boolean;
	readonly credentials?: boolean;
}

export interface ConfigSchema<T> {
	readonly parse: (input: unknown) => T;
	readonly jsonSchema?: unknown;
}

export interface Context {
	readonly id: string;
	readonly parent?: Context;
	readonly signal: AbortSignal;
	readonly mode: RuntimeMode;
	get<T>(key: ServiceKey<T>): T | undefined;
	require<T>(key: ServiceKey<T>): T;
	set<T>(key: ServiceKey<T>, value: T): Disposer;
	child(options?: { readonly id?: string; readonly isolate?: boolean }): Context;
}

export interface Fiber {
	readonly id: string;
	readonly pluginName: string;
	readonly context: Context;
	readonly status: PluginStatus;
	readonly signal: AbortSignal;
	addDisposer(disposer: Disposer): void;
	dispose(): Promise<void>;
}

export type PluginApply<Config> = (
	context: Context,
	config: Config,
	fiber: Fiber,
) => void | Disposer | Promise<undefined | Disposer>;

export interface PluginDefinition<Config = unknown> {
	readonly name: string;
	readonly version?: string;
	readonly apiVersion?: number;
	readonly inject?: readonly string[];
	readonly Config?: ConfigSchema<Config>;
	readonly capabilities?: PluginCapabilities;
	readonly apply: PluginApply<Config>;
}

export type RuntimeEvent =
	| {
			readonly type: "plugin_status";
			readonly pluginName: string;
			readonly status: PluginStatus;
			readonly previousStatus?: PluginStatus;
	  }
	| { readonly type: "plugin_error"; readonly pluginName: string; readonly error: Error }
	| { readonly type: "context_created"; readonly contextId: string; readonly parentId?: string }
	| { readonly type: "context_disposed"; readonly contextId: string }
	| { readonly type: "runtime_mode"; readonly mode: RuntimeMode };

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	const type = value.type;
	return (
		type === "plugin_status" ||
		type === "plugin_error" ||
		type === "context_created" ||
		type === "context_disposed" ||
		type === "runtime_mode"
	);
}

export interface RegistryOwner {
	readonly fiberId: string;
	readonly pluginName: string;
}

export interface RegistryEntry<T> {
	readonly name: string;
	readonly value: T;
	readonly owner: RegistryOwner;
}

export interface RegistrySnapshot<T> {
	readonly entries: readonly RegistryEntry<T>[];
}

export interface Registry<T> {
	register(name: string, value: T, owner: RegistryOwner): Disposer;
	get(name: string): RegistryEntry<T> | undefined;
	snapshot(): RegistrySnapshot<T>;
}
