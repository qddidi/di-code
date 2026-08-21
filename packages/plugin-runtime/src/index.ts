import type { AgentContextProvider, AgentTool, AgentToolResult, ToolExecutionMiddleware } from "@di-code/agent";
import type { TSchema } from "@di-code/ai";
import type { PluginInteractiveFrontend, PluginInteractivePanel, PluginToolDetailRenderer } from "./frontend/index.ts";
import type { SubagentProvider } from "./subagents.ts";

export type {
	ActiveRunSnapshot,
	ActiveRunState,
	DynamicPackageDefinition,
	DynamicPackageSnapshot,
	DynamicPackageState,
	DynamicPluginInspection,
	DynamicPluginLimits,
	DynamicPluginRequest,
	DynamicPluginResponse,
	DynamicPluginRpcMethod,
	DynamicPluginRpcRequest,
	DynamicPluginRpcResponse,
	PluginDefineRequest,
	PluginRunRequest,
	PluginStopRequest,
} from "./dynamic/index.ts";
export {
	ActiveRun,
	DYNAMIC_PLUGIN_MAX_LINE_BYTES,
	DYNAMIC_PLUGIN_MAX_SOURCE_BYTES,
	DYNAMIC_PLUGIN_PROTOCOL_VERSION,
	DynamicPluginRuntime,
	encodeDynamicPluginJsonl,
	Package,
	parseDynamicPluginJsonl,
	parseDynamicPluginJsonlRecord,
	parseDynamicPluginRecord,
	parseDynamicPluginRequest,
	parseDynamicPluginRequestLine,
	parseDynamicPluginResponse,
	stringifyDynamicPluginJsonl,
} from "./dynamic/index.ts";
export type {
	InteractiveFrontend,
	InteractiveFrontendCapability,
	PluginFrontendController,
	PluginInteractiveFrontend,
	PluginInteractivePanel,
	PluginTerminalFrontendHost,
	PluginToolDetailRenderer,
	PluginUiContributions,
} from "./frontend/index.ts";
export {
	missingInteractiveFrontendCapabilities,
	REQUIRED_INTERACTIVE_FRONTEND_CAPABILITIES,
} from "./frontend/index.ts";
export type {
	SubagentInput,
	SubagentProvider,
	SubagentResult,
	SubagentRun,
	SubagentStartRequest,
	SubagentStatus,
} from "./subagents.ts";

export const PLUGIN_API_VERSION = 1 as const;
export type PluginScopeState = "loading" | "active" | "stopping" | "stopped" | "failed";
export interface Disposable {
	dispose(): void | Promise<void>;
}
export interface PluginPermissions {
	readonly filesystem: "none" | "read-project" | "read-write-project";
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
	readonly capabilities?: readonly string[];
}
export interface PluginTool<T extends TSchema = TSchema> extends AgentTool<T, AgentToolResult> {}
export interface PluginPromptContext {
	readonly cwd: string;
	readonly mode: "interactive" | "print" | "json";
	readonly isProjectTrusted: boolean;
	readonly model: string;
	readonly signal?: AbortSignal;
}
export interface PluginPromptSection {
	readonly id: string;
	readonly order: number;
	render(context: PluginPromptContext): string | Promise<string | undefined>;
}
export interface PluginCommandContext {
	readonly args: string;
	readonly cwd: string;
	readonly sessionId?: string;
	readonly signal?: AbortSignal;
	notify(message: string): void;
}
export interface PluginCommand {
	readonly name: string;
	readonly description: string;
	handler(context: PluginCommandContext): void | Promise<void>;
}
export type PluginEventType = string;
export type PluginEventHandler<E extends PluginEventType = PluginEventType> = (
	event: E extends PluginEventType ? unknown : never,
	signal?: AbortSignal,
) => void | Promise<void>;
export interface PluginSessionProjection {
	readonly id: string;
	project(value: unknown): unknown | Promise<unknown>;
}
export interface PluginScope {
	readonly pluginId: string;
	readonly state: PluginScopeState;
	dispose(): Promise<void>;
}
export interface PluginApi {
	registerTool<T extends TSchema>(tool: PluginTool<T>): Disposable;
	registerCommand(command: PluginCommand): Disposable;
	registerPromptSection(section: PluginPromptSection): Disposable;
	useToolMiddleware(middleware: ToolExecutionMiddleware): Disposable;
	registerInteractiveFrontend(frontend: PluginInteractiveFrontend): Disposable;
	registerInteractivePanel(panel: PluginInteractivePanel): Disposable;
	registerToolDetailRenderer(renderer: PluginToolDetailRenderer): Disposable;
	registerSubagentProvider(provider: SubagentProvider): Disposable;
	on(event: string, handler: PluginEventHandler): Disposable;
	registerSessionProjection(projection: PluginSessionProjection): Disposable;
	effect(start: () => undefined | Disposable | Promise<undefined | Disposable>): Disposable;
}
export type PluginFactory = (api: PluginApi) => void | Promise<void>;
export interface PluginDiagnostic {
	readonly pluginId: string;
	readonly stage: "load" | "register" | "dispose" | "handler" | "prompt";
	readonly message: string;
	readonly cause?: unknown;
}
export interface PluginContributions {
	readonly tools: readonly PluginTool[];
	readonly commands: readonly PluginCommand[];
	readonly promptSections: readonly PluginPromptSection[];
	readonly toolMiddleware: readonly ToolExecutionMiddleware[];
	readonly frontends: readonly PluginInteractiveFrontend[];
	readonly panels: readonly PluginInteractivePanel[];
	readonly toolDetailRenderers: readonly PluginToolDetailRenderer[];
	readonly subagentProviders: readonly SubagentProvider[];
	readonly sessionProjections: readonly PluginSessionProjection[];
}
export interface PluginSnapshot {
	readonly version: number;
	readonly contributions: PluginContributions;
}
export interface PluginHostOptions {
	readonly cwd?: string;
	readonly mode?: PluginPromptContext["mode"];
	readonly projectTrusted?: boolean;
	readonly model?: string;
	readonly reservedCommands?: readonly string[];
	readonly baseSystemPrompt?: string;
}
export interface PluginContextProviderOptions {
	readonly systemPrompt?: string;
	readonly promptContext?: Omit<PluginPromptContext, "signal">;
}

type Mutable = {
	tools: PluginTool[];
	commands: PluginCommand[];
	promptSections: PluginPromptSection[];
	toolMiddleware: ToolExecutionMiddleware[];
	frontends: PluginInteractiveFrontend[];
	panels: PluginInteractivePanel[];
	toolDetailRenderers: PluginToolDetailRenderer[];
	subagentProviders: SubagentProvider[];
	sessionProjections: PluginSessionProjection[];
	handlers: Map<string, Array<{ pluginId: string; handler: PluginEventHandler }>>;
};
const empty = (): Mutable => ({
	tools: [],
	commands: [],
	promptSections: [],
	toolMiddleware: [],
	frontends: [],
	panels: [],
	toolDetailRenderers: [],
	subagentProviders: [],
	sessionProjections: [],
	handlers: new Map(),
});
const message = (cause: unknown): string => {
	const text = cause instanceof Error ? cause.message : String(cause);
	return text.replace(/(api[_-]?key|token|secret|authorization)\s*=[^\s]+/gi, "$1=[redacted]").slice(0, 500);
};
function idempotent(action: () => void | Promise<void>): () => void | Promise<void> {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		return action();
	};
}
function nonEmpty(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
}

class Scope implements PluginScope {
	private _state: PluginScopeState = "loading";
	private readonly disposers: Array<() => void | Promise<void>> = [];
	private promise?: Promise<void>;
	readonly pluginId: string;
	constructor(pluginId: string) {
		this.pluginId = pluginId;
	}
	get state(): PluginScopeState {
		return this._state;
	}
	activate(): void {
		this._state = "active";
	}
	fail(): void {
		this._state = "failed";
	}
	add(disposer: () => void | Promise<void>): void {
		this.disposers.push(disposer);
	}
	dispose(): Promise<void> {
		this.promise ??= this.close();
		return this.promise;
	}
	private async close(): Promise<void> {
		if (this._state === "stopped") return;
		this._state = "stopping";
		const failures: unknown[] = [];
		for (const disposer of [...this.disposers].reverse()) {
			try {
				await disposer();
			} catch (cause) {
				failures.push(cause);
			}
		}
		this.disposers.length = 0;
		this._state = "stopped";
		if (failures.length) throw new AggregateError(failures, "Plugin scope disposal failed");
	}
}

export class PluginHost {
	private readonly opts: Required<
		Pick<PluginHostOptions, "cwd" | "mode" | "projectTrusted" | "model" | "baseSystemPrompt">
	>;
	private readonly reserved: ReadonlySet<string>;
	private readonly scopes = new Map<string, Scope>();
	private readonly loading = new Set<string>();
	private readonly pluginRegistries = new Map<string, Mutable>();
	private readonly promptOwners = new Map<PluginPromptSection, string>();
	private registry = empty();
	private _version = 0;
	private readonly _diagnostics: PluginDiagnostic[] = [];
	constructor(options: PluginHostOptions = {}) {
		this.opts = {
			cwd: options.cwd ?? process.cwd(),
			mode: options.mode ?? "json",
			projectTrusted: options.projectTrusted ?? false,
			model: options.model ?? "",
			baseSystemPrompt: options.baseSystemPrompt ?? "",
		};
		this.reserved = new Set(options.reservedCommands ?? []);
	}
	get version(): number {
		return this._version;
	}
	get diagnostics(): readonly PluginDiagnostic[] {
		return [...this._diagnostics];
	}
	snapshot(): PluginSnapshot {
		const { handlers: _handlers, ...contributions } = this.registry;
		return {
			version: this._version,
			contributions: {
				tools: [...contributions.tools],
				commands: [...contributions.commands],
				promptSections: [...contributions.promptSections],
				toolMiddleware: [...contributions.toolMiddleware],
				frontends: [...contributions.frontends],
				panels: [...contributions.panels],
				toolDetailRenderers: [...contributions.toolDetailRenderers],
				subagentProviders: [...contributions.subagentProviders],
				sessionProjections: [...contributions.sessionProjections],
			},
		};
	}
	getToolMiddleware(): readonly ToolExecutionMiddleware[] {
		return [...this.registry.toolMiddleware];
	}
	listPluginIds(): readonly string[] {
		return [...this.scopes.keys()];
	}
	registerPlugin(pluginId: string, factory: PluginFactory): Promise<PluginScope> {
		return this.load(pluginId, factory);
	}
	async dispose(): Promise<void> {
		const failures: unknown[] = [];
		for (const pluginId of [...this.scopes.keys()].reverse()) {
			try {
				await this.unload(pluginId);
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Plugin host disposal failed");
	}
	async emit(event: string, payload: unknown, signal?: AbortSignal): Promise<void> {
		for (const entry of this.registry.handlers.get(event) ?? []) {
			try {
				await entry.handler(payload, signal);
			} catch (cause) {
				this._diagnostics.push({ pluginId: entry.pluginId, stage: "handler", message: message(cause), cause });
			}
		}
	}
	getContextProvider(options: PluginContextProviderOptions = {}): AgentContextProvider {
		return {
			resolve: async (signal) => {
				const contributionSnapshot = this.snapshot().contributions;
				const c = {
					cwd: options.promptContext?.cwd ?? this.opts.cwd,
					mode: options.promptContext?.mode ?? this.opts.mode,
					isProjectTrusted: options.promptContext?.isProjectTrusted ?? this.opts.projectTrusted,
					model: options.promptContext?.model ?? this.opts.model,
				};
				const sections = [...contributionSnapshot.promptSections].sort(
					(a, b) =>
						a.order - b.order ||
						(this.promptOwners.get(a) ?? "").localeCompare(this.promptOwners.get(b) ?? "") ||
						a.id.localeCompare(b.id),
				);
				const rendered: string[] = [];
				for (const section of sections) {
					try {
						const value = await section.render({ ...c, signal });
						if (value) rendered.push(value);
					} catch (cause) {
						this._diagnostics.push({ pluginId: "unknown", stage: "prompt", message: message(cause), cause });
						throw new Error(`Plugin prompt section "${section.id}" failed`, { cause });
					}
				}
				const base = options.systemPrompt ?? this.opts.baseSystemPrompt;
				return {
					systemPrompt: [base, ...rendered].filter(Boolean).join("\n\n") || undefined,
					toolMiddleware: [...contributionSnapshot.toolMiddleware],
					tools: [...contributionSnapshot.tools],
				};
			},
		};
	}
	async load(pluginId: string, factory: PluginFactory): Promise<PluginScope> {
		nonEmpty(pluginId, "pluginId");
		if (this.scopes.has(pluginId) || this.loading.has(pluginId))
			throw new Error(`Plugin already loaded: "${pluginId}"`);
		this.loading.add(pluginId);
		const scope = new Scope(pluginId);
		const staged = empty();
		const disposers: Array<() => void | Promise<void>> = [];
		const pendingStarts: Promise<void>[] = [];
		const api = this.api(pluginId, staged, disposers, pendingStarts);
		try {
			await factory(api);
			await Promise.all(pendingStarts);
			this.validate(pluginId, staged);
			for (const d of disposers) scope.add(d);
			this.commit(pluginId, staged);
			scope.activate();
			this.scopes.set(pluginId, scope);
			return scope;
		} catch (cause) {
			scope.fail();
			for (const d of [...disposers].reverse()) {
				try {
					await d();
				} catch (cleanup) {
					this._diagnostics.push({ pluginId, stage: "dispose", message: message(cleanup), cause: cleanup });
				}
			}
			this._diagnostics.push({ pluginId, stage: "load", message: message(cause), cause });
			throw cause;
		} finally {
			this.loading.delete(pluginId);
		}
	}
	async unload(pluginId: string): Promise<void> {
		const scope = this.scopes.get(pluginId);
		if (!scope) return;
		this.scopes.delete(pluginId);
		this.pluginRegistries.delete(pluginId);
		for (const [section, owner] of this.promptOwners) if (owner === pluginId) this.promptOwners.delete(section);
		this.registry = empty();
		for (const registry of this.pluginRegistries.values()) this.merge(registry);
		this._version++;
		try {
			await scope.dispose();
		} catch (cause) {
			this._diagnostics.push({ pluginId, stage: "dispose", message: message(cause), cause });
			throw cause;
		}
	}
	private api(
		pluginId: string,
		registry: Mutable,
		disposers: Array<() => void | Promise<void>>,
		pendingStarts: Promise<void>[],
	): PluginApi {
		const add = <T>(list: T[], value: T): Disposable => {
			list.push(value);
			const dispose = idempotent(() => {
				const i = list.indexOf(value);
				if (i >= 0) list.splice(i, 1);
				if (value instanceof Object && "order" in value)
					this.promptOwners.delete(value as unknown as PluginPromptSection);
				if (this.pluginRegistries.has(pluginId)) this.rebuild(true);
			});
			disposers.push(dispose);
			return { dispose };
		};
		return {
			registerTool: (tool) => add(registry.tools, tool),
			registerCommand: (command) => add(registry.commands, command),
			registerPromptSection: (section) => add(registry.promptSections, section),
			useToolMiddleware: (middleware) => add(registry.toolMiddleware, middleware),
			registerInteractiveFrontend: (frontend) => add(registry.frontends, frontend),
			registerInteractivePanel: (panel) => add(registry.panels, panel),
			registerToolDetailRenderer: (renderer) => add(registry.toolDetailRenderers, renderer),
			registerSubagentProvider: (provider) => add(registry.subagentProviders, provider),
			on: (event, handler) => {
				const list = registry.handlers.get(event) ?? [];
				const entry = { pluginId, handler };
				list.push(entry);
				registry.handlers.set(event, list);
				const dispose = idempotent(() => {
					const current = registry.handlers.get(event) ?? [];
					registry.handlers.set(
						event,
						current.filter((item) => item !== entry),
					);
					if (this.pluginRegistries.has(pluginId)) this.rebuild(true);
				});
				disposers.push(dispose);
				return { dispose };
			},
			registerSessionProjection: (projection) => add(registry.sessionProjections, projection),
			effect: (start) => {
				let cleanup: Disposable | undefined;
				const started = Promise.resolve()
					.then(start)
					.then((value) => {
						cleanup = value ?? undefined;
					});
				pendingStarts.push(started);
				const dispose = idempotent(async () => {
					await started;
					await cleanup?.dispose();
				});
				disposers.push(dispose);
				return { dispose };
			},
		};
	}
	private validate(pluginId: string, staged: Mutable): void {
		const tools = new Set(this.registry.tools.map((t) => t.name));
		for (const tool of staged.tools) {
			nonEmpty(tool.name, "tool.name");
			nonEmpty(tool.description, "tool.description");
			if (!tool.name.startsWith(`${pluginId}__`)) throw new Error(`Plugin tool namespace conflict: ${tool.name}`);
			if (typeof tool.execute !== "function") throw new Error("tool.execute must be a function");
			if (tools.has(tool.name)) throw new Error(`Plugin tool conflict: "${tool.name}"`);
			tools.add(tool.name);
		}
		const commands = new Set(this.registry.commands.map((c) => c.name));
		for (const command of staged.commands) {
			nonEmpty(command.name, "command.name");
			nonEmpty(command.description, "command.description");
			if (this.reserved.has(command.name))
				throw new Error(`Plugin command conflicts with built-in command: ${command.name}`);
			if (commands.has(command.name)) throw new Error(`Plugin command conflict: "${command.name}"`);
			commands.add(command.name);
		}
		const sectionIds = new Set<string>();
		for (const section of staged.promptSections) {
			nonEmpty(section.id, "prompt section id");
			if (!Number.isFinite(section.order) || typeof section.render !== "function")
				throw new Error("invalid prompt section");
			if (sectionIds.has(section.id)) throw new Error(`Plugin prompt section conflict: "${section.id}"`);
			sectionIds.add(section.id);
		}
		this.validateUnique(staged.frontends, this.registry.frontends, "frontend");
		for (const frontend of staged.frontends) {
			if (!Array.isArray(frontend.capabilities) || typeof frontend.create !== "function")
				throw new Error("invalid interactive frontend");
		}
		this.validateUnique(staged.panels, this.registry.panels, "interactive panel");
		for (const panel of staged.panels) nonEmpty(panel.title, "interactive panel.title");
		for (const renderer of staged.toolDetailRenderers) {
			nonEmpty(renderer.toolName, "tool detail renderer.toolName");
			if (typeof renderer.render !== "function") throw new Error("tool detail renderer.render must be a function");
		}
		const renderedTools = new Set(this.registry.toolDetailRenderers.map((renderer) => renderer.toolName));
		for (const renderer of staged.toolDetailRenderers) {
			if (renderedTools.has(renderer.toolName))
				throw new Error(`Plugin tool detail renderer conflict: "${renderer.toolName}"`);
			renderedTools.add(renderer.toolName);
		}
		this.validateUnique(staged.subagentProviders, this.registry.subagentProviders, "subagent provider");
		for (const provider of staged.subagentProviders) {
			if (typeof provider.start !== "function") throw new Error("subagent provider.start must be a function");
		}
		this.validateUnique(staged.sessionProjections, this.registry.sessionProjections, "session projection");
	}
	private validateUnique<T extends { id: string }>(staged: T[], existing: readonly T[], kind: string): void {
		const ids = new Set(existing.map((item) => item.id));
		for (const item of staged) {
			nonEmpty(item.id, `${kind}.id`);
			if (ids.has(item.id)) throw new Error(`Plugin ${kind} conflict: "${item.id}"`);
			ids.add(item.id);
		}
	}
	private commit(pluginId: string, staged: Mutable): void {
		this.pluginRegistries.set(pluginId, staged);
		for (const section of staged.promptSections) this.promptOwners.set(section, pluginId);
		this.rebuild(false);
		this._version++;
	}
	private rebuild(increment: boolean): void {
		this.registry = empty();
		for (const staged of this.pluginRegistries.values()) this.merge(staged);
		if (increment) this._version++;
	}
	private merge(staged: Mutable): void {
		const handlers = new Map(this.registry.handlers);
		for (const [event, entries] of staged.handlers) {
			handlers.set(event, [...(handlers.get(event) ?? []), ...entries]);
		}
		this.registry = {
			tools: [...this.registry.tools, ...staged.tools],
			commands: [...this.registry.commands, ...staged.commands],
			promptSections: [...this.registry.promptSections, ...staged.promptSections],
			toolMiddleware: [...this.registry.toolMiddleware, ...staged.toolMiddleware],
			frontends: [...this.registry.frontends, ...staged.frontends],
			panels: [...this.registry.panels, ...staged.panels],
			toolDetailRenderers: [...this.registry.toolDetailRenderers, ...staged.toolDetailRenderers],
			subagentProviders: [...this.registry.subagentProviders, ...staged.subagentProviders],
			sessionProjections: [...this.registry.sessionProjections, ...staged.sessionProjections],
			handlers,
		};
	}
}

export function createPluginHost(options?: PluginHostOptions): PluginHost {
	return new PluginHost(options);
}
export function parsePluginManifest(value: unknown): PluginManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin manifest must be an object");
	const r = value as Record<string, unknown>;
	if (r.apiVersion !== PLUGIN_API_VERSION) throw new Error(`plugin API version must be ${PLUGIN_API_VERSION}`);
	for (const field of ["id", "name", "version", "entry"] as const) nonEmpty(r[field], `plugin manifest ${field}`);
	if (!(r.id as string).match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) || (r.id as string).length > 64)
		throw new Error("plugin manifest id must use lowercase letters, numbers, and single hyphens");
	if (
		(r.entry as string).startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(r.entry as string) ||
		(r.entry as string).split(/[\\/]/).some((part) => part === "..")
	)
		throw new Error("plugin manifest entry must be relative to the plugin root");
	if (!r.permissions || typeof r.permissions !== "object" || Array.isArray(r.permissions))
		throw new Error("plugin manifest permissions must be an object");
	const p = r.permissions as Record<string, unknown>;
	if (p.filesystem !== "none" && p.filesystem !== "read-project" && p.filesystem !== "read-write-project")
		throw new Error("invalid plugin filesystem permission");
	if (
		!Array.isArray(p.network) ||
		!p.network.every((x) => typeof x === "string" && x.trim() !== "") ||
		!Array.isArray(p.process) ||
		!p.process.every((x) => typeof x === "string" && x.trim() !== "")
	)
		throw new Error("invalid plugin permissions");
	if (!(p.process as string[]).every((command) => /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(command)))
		throw new Error("plugin permissions.process only permits exact command names");
	if (
		!(p.network as string[]).every((url) => {
			try {
				return new URL(url).protocol === "https:";
			} catch {
				return false;
			}
		})
	)
		throw new Error("plugin permissions.network only permits absolute HTTPS URLs");
	if (
		r.capabilities !== undefined &&
		(!Array.isArray(r.capabilities) || !r.capabilities.every((item) => typeof item === "string" && item.trim() !== ""))
	)
		throw new Error("plugin manifest capabilities must be an array of non-empty strings");
	return {
		apiVersion: PLUGIN_API_VERSION,
		id: r.id as string,
		name: r.name as string,
		version: r.version as string,
		entry: r.entry as string,
		permissions: { filesystem: p.filesystem, network: p.network as string[], process: p.process as string[] },
		capabilities: r.capabilities as string[] | undefined,
	};
}
