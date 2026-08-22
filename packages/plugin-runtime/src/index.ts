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

export interface RegistryOwner {
	readonly fiberId: string;
	readonly pluginName: string;
	readonly fiber?: Fiber;
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

export type RuntimeEvent =
	| {
			readonly type: "plugin_status";
			readonly pluginName: string;
			readonly status: PluginStatus;
			readonly previousStatus?: PluginStatus;
			readonly fiberId?: string;
	  }
	| { readonly type: "plugin_error"; readonly pluginName: string; readonly error: Error; readonly fiberId?: string }
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

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** Synchronous observer bus used for lifecycle diagnostics. Handler errors are isolated. */
export class RuntimeEventBus {
	private readonly listeners = new Set<RuntimeEventListener>();

	subscribe(listener: RuntimeEventListener): Disposer {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	publish(event: RuntimeEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// Observers are diagnostics only and cannot break lifecycle transitions.
			}
		}
	}
}

export interface ContextChildOptions {
	readonly id?: string;
	readonly isolate?: boolean;
}

export interface Context {
	readonly id: string;
	readonly parent?: Context;
	readonly signal: AbortSignal;
	readonly mode: RuntimeMode;
	readonly events: RuntimeEventBus;
	readonly services: ServiceRegistry;
	get<T>(key: ServiceKey<T>): T | undefined;
	require<T>(key: ServiceKey<T>): T;
	set<T>(key: ServiceKey<T>, value: T): Disposer;
	child(options?: ContextChildOptions): Context;
	plugin<TConfig>(definition: PluginDefinition<TConfig>, config: TConfig): Promise<Fiber>;
	dispose(): Promise<void>;
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
) => void | Disposer | Promise<void | Disposer>;

export interface PluginDefinition<Config = unknown> {
	readonly name: string;
	readonly version?: string;
	readonly apiVersion?: number;
	readonly inject?: readonly string[];
	readonly Config?: ConfigSchema<Config>;
	readonly capabilities?: PluginCapabilities;
	readonly apply: PluginApply<Config>;
}

export interface ServiceRegistryEntry<T> {
	readonly key: ServiceKey<T>;
	readonly value: T;
	readonly name: string;
	readonly owner: Fiber;
	readonly contextId: string;
	published: boolean;
}

let nextId = 0;

function generatedId(prefix: string): string {
	nextId += 1;
	return `${prefix}-${nextId}`;
}

function keyName(key: ServiceKey<unknown>): string {
	return key.description ?? String(key);
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function aggregate(message: string, errors: readonly unknown[]): Error | undefined {
	if (errors.length === 0) return undefined;
	if (errors.length === 1) return asError(errors[0]);
	return new AggregateError(errors.map(asError), message);
}

function combinedSignal(parent: AbortSignal, own: AbortSignal): AbortSignal {
	return AbortSignal.any([parent, own]);
}

/** Owner-aware service storage. Pending entries are deliberately invisible until committed. */
export class ServiceRegistry {
	private readonly records = new Map<ServiceKey<unknown>, ServiceRegistryEntry<unknown>>();

	get<T>(key: ServiceKey<T>): T | undefined {
		const record = this.records.get(key as ServiceKey<unknown>);
		return record?.published ? (record.value as T) : undefined;
	}

	getEntry<T>(key: ServiceKey<T>): ServiceRegistryEntry<T> | undefined {
		const record = this.records.get(key as ServiceKey<unknown>);
		return record?.published ? ({ ...record } as ServiceRegistryEntry<T>) : undefined;
	}

	register<T>(key: ServiceKey<T>, value: T, owner: Fiber, contextId: string): Disposer {
		if (owner.status !== "loading" && owner.status !== "active") {
			throw new Error(`Cannot register service ${keyName(key)} while Fiber ${owner.id} is ${owner.status}`);
		}
		if (this.records.has(key as ServiceKey<unknown>)) {
			throw new Error(`Duplicate service registration: ${keyName(key)}`);
		}
		const record: ServiceRegistryEntry<T> = {
			key,
			value,
			name: keyName(key),
			owner,
			contextId,
			published: owner.status === "active",
		};
		this.records.set(key as ServiceKey<unknown>, record as ServiceRegistryEntry<unknown>);
		let removed = false;
		const disposer: Disposer = () => {
			if (removed) return;
			removed = true;
			if (this.records.get(key as ServiceKey<unknown>) === record) this.records.delete(key as ServiceKey<unknown>);
		};
		try {
			owner.addDisposer(disposer);
		} catch (error) {
			disposer();
			throw error;
		}
		return disposer;
	}

	commit(owner: Fiber): void {
		for (const record of this.records.values()) {
			if (record.owner === owner) record.published = true;
		}
	}

	rollback(owner: Fiber): void {
		for (const [key, record] of this.records) {
			if (record.owner === owner) this.records.delete(key);
		}
	}

	clearContext(contextId: string): void {
		for (const [key, record] of this.records) {
			if (record.contextId === contextId) this.records.delete(key);
		}
	}

	snapshot(): readonly ServiceRegistryEntry<unknown>[] {
		return [...this.records.values()].filter((record) => record.published).map((record) => ({ ...record }));
	}
}

class ContextOwnerFiber implements Fiber {
	readonly id: string;
	readonly pluginName: string;
	readonly signal: AbortSignal;
	readonly context: Context;
	readonly status = "active" as const;

	constructor(context: Context) {
		this.id = `${context.id}:context`;
		this.pluginName = "context";
		this.context = context;
		this.signal = context.signal;
	}

	addDisposer(_disposer: Disposer): void {
		// Context-owned services live until their Context is disposed.
	}

	async dispose(): Promise<void> {
		return;
	}
}

class RuntimeContext implements Context {
	readonly id: string;
	readonly parent?: Context;
	readonly mode: RuntimeMode;
	readonly events: RuntimeEventBus;
	readonly signal: AbortSignal;
	readonly services: ServiceRegistry;

	private readonly inheritServices: boolean;
	private readonly owner?: Fiber;
	private readonly fibers = new Set<RuntimeFiber>();
	private readonly children = new Set<RuntimeContext>();
	private readonly controller = new AbortController();
	private disposed = false;
	private readonly contextOwner: ContextOwnerFiber;

	constructor(options: {
		readonly id: string;
		readonly mode: RuntimeMode;
		readonly parent?: RuntimeContext;
		readonly isolate?: boolean;
		readonly events?: RuntimeEventBus;
		readonly owner?: Fiber;
		readonly services?: ServiceRegistry;
		readonly signal?: AbortSignal;
	}) {
		this.id = options.id;
		this.parent = options.parent;
		this.mode = options.mode;
		this.events = options.events ?? new RuntimeEventBus();
		this.services = options.services ?? new ServiceRegistry();
		this.inheritServices = !options.isolate;
		this.owner = options.owner;
		this.signal = options.signal ? combinedSignal(options.signal, this.controller.signal) : this.controller.signal;
		this.contextOwner = new ContextOwnerFiber(this);
		if (options.parent) options.parent.children.add(this);
		this.events.publish({ type: "context_created", contextId: this.id, parentId: options.parent?.id });
	}

	get<T>(key: ServiceKey<T>): T | undefined {
		const local = this.services.get(key);
		if (local !== undefined) return local;
		if (this.inheritServices && this.parent instanceof RuntimeContext) return this.parent.get(key);
		return undefined;
	}

	require<T>(key: ServiceKey<T>): T {
		const value = this.get(key);
		if (value === undefined) throw new Error(`Required service is not registered: ${keyName(key)}`);
		return value;
	}

	set<T>(key: ServiceKey<T>, value: T): Disposer {
		if (this.disposed) throw new Error(`Context ${this.id} is disposed`);
		const owner = this.owner ?? this.contextOwner;
		return this.services.register(key, value, owner, this.id);
	}

	child(options: ContextChildOptions = {}): Context {
		if (this.disposed) throw new Error(`Context ${this.id} is disposed`);
		return this.createChild(options, this.owner);
	}

	createChild(options: ContextChildOptions, owner?: Fiber): RuntimeContext {
		return new RuntimeContext({
			id: options.id ?? generatedId(`${this.id}.child`),
			mode: this.mode,
			parent: this,
			isolate: options.isolate,
			events: this.events,
			owner,
			signal: this.signal,
		});
	}

	async plugin<TConfig>(definition: PluginDefinition<TConfig>, config: TConfig): Promise<Fiber> {
		if (this.disposed) throw new Error(`Context ${this.id} is disposed`);
		const fiber = new RuntimeFiber(this, definition.name);
		this.registerFiber(fiber);
		await fiber.start(definition.apply, config);
		return fiber;
	}

	registerFiber(fiber: RuntimeFiber): void {
		this.fibers.add(fiber);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.abort(new Error(`Context ${this.id} disposed`));
		const errors: unknown[] = [];
		for (const child of [...this.children].reverse()) {
			try {
				await child.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		for (const fiber of [...this.fibers].reverse()) {
			try {
				await fiber.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		this.events.publish({ type: "context_disposed", contextId: this.id });
		this.services.clearContext(this.id);
		const error = aggregate(`Context ${this.id} disposal failed`, errors);
		if (error) throw error;
	}

	bind(fiber: RuntimeFiber): Context {
		return new BoundContext(this, fiber);
	}

	removeFiber(fiber: RuntimeFiber): void {
		this.fibers.delete(fiber);
	}

	isDisposed(): boolean {
		return this.disposed;
	}
}

class BoundContext implements Context {
	readonly id: string;
	readonly parent?: Context;
	readonly mode: RuntimeMode;
	readonly events: RuntimeEventBus;
	readonly signal: AbortSignal;
	readonly services: ServiceRegistry;

	private readonly base: RuntimeContext;
	private readonly owner: RuntimeFiber;

	constructor(base: RuntimeContext, owner: RuntimeFiber) {
		this.base = base;
		this.owner = owner;
		this.id = base.id;
		this.parent = base.parent;
		this.mode = base.mode;
		this.events = base.events;
		this.signal = combinedSignal(base.signal, owner.signal);
		this.services = base.services;
	}

	get<T>(key: ServiceKey<T>): T | undefined {
		return this.base.get(key);
	}

	require<T>(key: ServiceKey<T>): T {
		return this.base.require(key);
	}

	set<T>(key: ServiceKey<T>, value: T): Disposer {
		if (this.base.isDisposed()) throw new Error(`Context ${this.base.id} is disposed`);
		if (this.owner.status !== "loading" && this.owner.status !== "active") {
			throw new Error(`Fiber ${this.owner.id} is ${this.owner.status}; late service registration rejected`);
		}
		return this.base.services.register(key, value, this.owner, this.base.id);
	}

	child(options: ContextChildOptions = {}): Context {
		return this.base.createChild(options, this.owner).bind(this.owner) as Context;
	}

	plugin<TConfig>(definition: PluginDefinition<TConfig>, config: TConfig): Promise<Fiber> {
		return this.base.plugin(definition, config);
	}

	dispose(): Promise<void> {
		return this.base.dispose();
	}
}

/** Fiber state machine for one plugin instance. */
export class RuntimeFiber implements Fiber {
	readonly id: string;
	readonly pluginName: string;
	readonly signal: AbortSignal;
	readonly context: Context;

	private readonly controller = new AbortController();
	private readonly disposers: Disposer[] = [];
	private disposePromise?: Promise<void>;
	private setupPromise?: Promise<void>;
	private _status: PluginStatus = "pending";
	private readonly baseContext: RuntimeContext;

	constructor(baseContext: RuntimeContext, pluginName: string, id = generatedId("fiber")) {
		this.baseContext = baseContext;
		this.id = id;
		this.pluginName = pluginName;
		this.signal = combinedSignal(baseContext.signal, this.controller.signal);
		this.context = baseContext.bind(this);
	}

	get status(): PluginStatus {
		return this._status;
	}

	addDisposer(disposer: Disposer): void {
		if (this._status === "disposed" || this._status === "unloading") {
			throw new Error(`Fiber ${this.id} is ${this._status}; late disposer rejected`);
		}
		this.disposers.push(disposer);
	}

	async start<Config>(apply: PluginApply<Config>, config: Config): Promise<void> {
		if (this._status !== "pending") throw new Error(`Fiber ${this.id} cannot start from ${this._status}`);
		this.transition("loading");
		this.setupPromise = this.runApply(apply, config);
		await this.setupPromise;
	}

	private async runApply<Config>(apply: PluginApply<Config>, config: Config): Promise<void> {
		try {
			const returned = await apply(this.context, config, this);
			if (returned) this.addDisposer(returned);
			if (this._status === "unloading" || this._status === "disposed") {
				await this.cleanup();
				return;
			}
			this.baseContext.services.commit(this);
			this.transition("active");
		} catch (error) {
			this.baseContext.services.rollback(this);
			const cleanupError = await this.cleanup();
			if (this._status !== "unloading" && this._status !== "disposed") this.transition("failed");
			this.baseContext.events.publish({
				type: "plugin_error",
				pluginName: this.pluginName,
				error: asError(error),
				fiberId: this.id,
			});
			const combined = aggregate(`Plugin ${this.pluginName} apply failed`, [error, cleanupError].filter(Boolean));
			throw combined ?? asError(error);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = this.performDispose();
		return this.disposePromise;
	}

	private async performDispose(): Promise<void> {
		if (this._status === "disposed") return;
		if (this._status !== "unloading") this.transition("unloading");
		this.controller.abort(new Error(`Fiber ${this.id} disposed`));
		if (this.setupPromise) {
			try {
				await this.setupPromise;
			} catch {
				// Apply failure is already represented by failed status and plugin_error.
			}
		}
		const cleanupError = await this.cleanup();
		this.baseContext.services.rollback(this);
		this.transition("disposed");
		this.baseContext.removeFiber(this);
		if (cleanupError) throw cleanupError;
	}

	private async cleanup(): Promise<Error | undefined> {
		const errors: unknown[] = [];
		for (const disposer of [...this.disposers].reverse()) {
			try {
				await disposer();
			} catch (error) {
				errors.push(error);
			}
		}
		this.disposers.length = 0;
		return aggregate(`Fiber ${this.id} disposal failed`, errors);
	}

	private transition(status: PluginStatus): void {
		const previousStatus = this._status;
		this._status = status;
		this.baseContext.events.publish({
			type: "plugin_status",
			pluginName: this.pluginName,
			status,
			previousStatus,
			fiberId: this.id,
		});
	}
}

export class RootContext extends RuntimeContext {
	constructor(options: { readonly id?: string; readonly mode?: RuntimeMode; readonly signal?: AbortSignal } = {}) {
		super({ id: options.id ?? "root", mode: options.mode ?? "test", signal: options.signal });
	}
}

export class ChildContext extends RuntimeContext {
	constructor(parent: RuntimeContext, options: ContextChildOptions = {}) {
		super({
			id: options.id ?? generatedId(`${parent.id}.child`),
			mode: parent.mode,
			parent,
			isolate: options.isolate,
			events: parent.events,
			signal: parent.signal,
		});
	}
}

export function createRootContext(
	options: { readonly id?: string; readonly mode?: RuntimeMode; readonly signal?: AbortSignal } = {},
): RootContext {
	return new RootContext(options);
}

export function createChildContext(parent: Context, options: ContextChildOptions = {}): Context {
	return parent.child(options);
}

export function createFiber(context: Context, pluginName: string, id?: string): Fiber {
	if (!(context instanceof RuntimeContext)) throw new TypeError("createFiber requires a runtime Context");
	const fiber = new RuntimeFiber(context, pluginName, id);
	context.registerFiber(fiber);
	return fiber;
}

export async function activatePlugin<TConfig>(
	context: Context,
	definition: PluginDefinition<TConfig>,
	config: TConfig,
): Promise<Fiber> {
	return context.plugin(definition, config);
}
