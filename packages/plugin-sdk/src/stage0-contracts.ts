import { createServiceKey, type Disposer, type ServiceKey } from "@di-code/plugin-runtime";

import {
	createSessionEventRegistry,
	createSessionProjectionRegistry,
	type SessionEventEnvelope,
	type SessionEventRegistry,
	type SessionProjectionRegistry,
} from "./stage4-contracts.ts";
import type { UserInteraction } from "./stage6-contracts.ts";
import { createSessionExtensionRegistry, type SessionExtensionRegistry } from "./stage7-contracts.ts";

/** Public runtime contracts shared by Session-scoped plugins. */
export const PLUGIN_SDK_API_VERSION = 1 as const;
export type PluginSdkApiVersion = typeof PLUGIN_SDK_API_VERSION;

export type PluginErrorCode = "FAILED" | "CANCELLED" | "TIMEOUT" | "DISPOSED";

export interface PluginOperationContext {
	readonly signal: AbortSignal;
	readonly requestId?: string;
	readonly deadlineAt?: number;
}

export interface SessionPluginContext extends PluginOperationContext {
	readonly sessionId: string;
	readonly promptSections: PromptSectionRegistry;
	readonly hooks: AgentHookRegistry;
	readonly events: SessionEventRegistry;
	readonly projections: SessionProjectionRegistry;
	readonly extensions: SessionExtensionRegistry;
	readonly interaction?: UserInteraction;
	/** Appends a validated, versioned event through the host Session queue. */
	readonly appendEvent: (event: SessionEventEnvelope, signal?: AbortSignal) => Promise<void>;
	readonly onDispose: (disposer: () => void | Promise<void>) => void;
}

export type SessionPluginInitializer<Config = unknown> = (
	context: SessionPluginContext,
	config: Config,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export interface SessionPluginCapabilities {
	readonly [name: string]: boolean;
}

/** Public, session-owned plugin scope. It contains no Agent, SessionManager, transport, or file handle. */
export interface SessionPluginScope {
	readonly sessionId: string;
	readonly signal: AbortSignal;
	readonly capabilities: Readonly<SessionPluginCapabilities>;
	readonly promptSections: PromptSectionRegistry;
	readonly hooks: AgentHookRegistry;
	readonly events: SessionEventRegistry;
	readonly projections: SessionProjectionRegistry;
	readonly extensions: SessionExtensionRegistry;
	readonly interaction?: UserInteraction;
	/** Appends a versioned event without exposing SessionManager internals. */
	readonly appendEvent: (event: SessionEventEnvelope, signal?: AbortSignal) => Promise<void>;
	readonly onDispose: (disposer: () => void | Promise<void>) => void;
	readonly dispose: () => Promise<void>;
}

export interface PromptSectionSnapshot {
	readonly agent: {
		readonly turnIndex: number;
		readonly stepIndex: number;
		readonly messageCount: number;
	};
	readonly session?: unknown;
}

export interface PromptSectionContext extends PromptSectionSnapshot {
	readonly signal: AbortSignal;
}

export interface PromptSectionRegistration {
	readonly name: string;
	readonly order: number;
	readonly owner: string;
	readonly generate: (context: PromptSectionContext) => string | undefined | Promise<string | undefined>;
}

export interface PromptSectionRegistry {
	readonly register: (section: PromptSectionRegistration) => Disposer;
	readonly snapshot: () => readonly PromptSectionRegistration[];
}

export interface AgentHookRegistry {
	readonly register: (hook: AgentHookRegistration) => Disposer;
	readonly snapshot: () => readonly AgentHookRegistration[];
	readonly subscribe: (listener: (hook: AgentHookRegistration, active: boolean) => void) => Disposer;
	readonly clear: () => void;
}

export function createAgentHookRegistry(): AgentHookRegistry {
	const hooks: AgentHookRegistration[] = [];
	const listeners = new Set<(hook: AgentHookRegistration, active: boolean) => void>();
	return {
		register(hook) {
			if (hook.kind === "modifier" && hook.phase !== "pre_step")
				throw new TypeError("Agent modifier hooks are only allowed in pre_step.");
			hooks.push(hook);
			for (const listener of listeners) listener(hook, true);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				const index = hooks.indexOf(hook);
				if (index >= 0) {
					hooks.splice(index, 1);
					for (const listener of listeners) listener(hook, false);
				}
			};
		},
		snapshot: () => Object.freeze([...hooks]),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			for (const hook of [...hooks]) {
				hooks.splice(hooks.indexOf(hook), 1);
				for (const listener of listeners) listener(hook, false);
			}
		},
	};
}

export function createPromptSectionRegistry(): PromptSectionRegistry {
	const sections = new Map<string, PromptSectionRegistration>();
	const registry = {
		register(section: PromptSectionRegistration) {
			if (!/^[a-z0-9][a-z0-9._:-]*$/.test(section.name)) throw new TypeError("Invalid prompt section name.");
			if (section.owner.trim().length === 0) throw new TypeError("Prompt section owner must not be empty.");
			if (!Number.isFinite(section.order)) throw new TypeError("Prompt section order must be finite.");
			if (sections.has(section.name))
				throw new PluginLifecycleError("DUPLICATE", `Duplicate prompt section: ${section.name}`);
			sections.set(section.name, section);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (sections.get(section.name) === section) sections.delete(section.name);
			};
		},
		snapshot: () => Object.freeze([...sections.values()]),
		clear: () => sections.clear(),
	};
	return registry;
}

export interface SessionPluginFactory<Config = unknown> {
	readonly create: (sessionId: string, config: Config, host?: SessionPluginHost) => Promise<SessionPluginScope>;
	readonly dispose: () => Promise<void>;
}

/** Host-owned persistence boundary made available to a Session plugin scope. */
export interface SessionPluginHost {
	readonly appendEvent: (event: SessionEventEnvelope, signal?: AbortSignal) => Promise<void>;
}

export interface SessionPluginFactoryOptions {
	readonly capabilities?: SessionPluginCapabilities;
	readonly interaction?: UserInteraction;
}

export interface SessionPluginRegistration {
	readonly name: string;
	readonly factory: SessionPluginFactory<unknown>;
	readonly config: unknown;
}

export interface SessionPluginRegistry {
	readonly register: (registration: SessionPluginRegistration) => Disposer;
	readonly snapshot: () => readonly SessionPluginRegistration[];
}

export const sessionPluginRegistryKey: ServiceKey<SessionPluginRegistry> = createServiceKey("session-plugin-registry");

export function createSessionPluginRegistry(): SessionPluginRegistry {
	const registrations = new Map<string, SessionPluginRegistration>();
	return {
		register(registration) {
			if (!/^[a-z0-9][a-z0-9._-]*$/.test(registration.name)) throw new TypeError("Invalid Session plugin name.");
			if (registrations.has(registration.name))
				throw new PluginLifecycleError("DUPLICATE", `Session plugin is already registered: ${registration.name}`);
			registrations.set(registration.name, registration);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (registrations.get(registration.name) === registration) registrations.delete(registration.name);
				return registration.factory.dispose();
			};
		},
		snapshot: () => Object.freeze([...registrations.values()]),
	};
}

/** Creates a concurrency-safe factory whose scopes are isolated and idempotently disposable. */
export function createSessionPluginFactory<Config = unknown>(
	initializer: SessionPluginInitializer<Config>,
	options: SessionPluginFactoryOptions = {},
): SessionPluginFactory<Config> {
	const scopes = new Map<string, Promise<SessionPluginScope>>();
	const capabilities = Object.freeze({ ...(options.capabilities ?? {}) });
	let disposed = false;

	const create = async (sessionId: string, config: Config, host?: SessionPluginHost): Promise<SessionPluginScope> => {
		if (disposed) throw new PluginLifecycleError("DISPOSED", "Session plugin factory has been disposed.");
		if (typeof sessionId !== "string" || sessionId.length === 0)
			throw new TypeError("Session plugin sessionId must be a non-empty string.");
		if (scopes.has(sessionId))
			throw new PluginLifecycleError("DUPLICATE", `Session plugin scope already exists: ${sessionId}`);
		const controller = new AbortController();
		const promptSections = createPromptSectionRegistry();
		const hooks = createAgentHookRegistry();
		const events = createSessionEventRegistry();
		const projections = createSessionProjectionRegistry();
		const extensions = createSessionExtensionRegistry(sessionId);
		const disposers: Array<() => void | Promise<void>> = [];
		let scopeDisposed = false;
		let disposePromise: Promise<void> | undefined;
		const scope: SessionPluginScope = {
			sessionId,
			signal: controller.signal,
			capabilities,
			promptSections,
			hooks,
			events,
			projections,
			extensions,
			...(options.interaction ? { interaction: options.interaction } : {}),
			appendEvent:
				host?.appendEvent ??
				(async () => {
					throw new Error("Session event persistence is unavailable.");
				}),
			onDispose(disposer) {
				if (scopeDisposed) throw new PluginLifecycleError("DISPOSED", "Session plugin scope is disposed.");
				disposers.push(disposer);
			},
			dispose: async () => {
				if (disposePromise) return disposePromise;
				disposePromise = (async () => {
					if (scopeDisposed) return;
					scopeDisposed = true;
					controller.abort(new Error(`Session plugin scope ${sessionId} disposed`));
					(promptSections as PromptSectionRegistry & { readonly clear: () => void }).clear();
					hooks.clear();
					events.clear();
					projections.clear();
					extensions.clear();
					const errors: unknown[] = [];
					for (const disposer of [...disposers].reverse()) {
						try {
							await disposer();
						} catch (error) {
							errors.push(error);
						}
					}
					disposers.length = 0;
					if (errors.length > 0) throw new AggregateError(errors, `Session plugin scope ${sessionId} disposal failed`);
				})();
				return disposePromise;
			},
		};
		const pending = (async () => {
			try {
				const returned = await initializer(scope, config);
				if (returned) scope.onDispose(returned);
				return scope;
			} catch (error) {
				await scope.dispose().catch(() => undefined);
				throw error;
			}
		})();
		scopes.set(sessionId, pending);
		try {
			return await pending;
		} catch (error) {
			if (scopes.get(sessionId) === pending) scopes.delete(sessionId);
			throw error;
		}
	};

	return {
		create,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			const pending = [...scopes.values()];
			const settled = await Promise.allSettled(pending);
			scopes.clear();
			const errors: unknown[] = [];
			for (const result of settled) {
				if (result.status === "fulfilled") {
					try {
						await result.value.dispose();
					} catch (error) {
						errors.push(error);
					}
				} else errors.push(result.reason);
			}
			if (errors.length > 0) throw new AggregateError(errors, "Session plugin factory disposal failed");
		},
	};
}

export class PluginLifecycleError extends Error {
	readonly code: "DISPOSED" | "DUPLICATE";
	constructor(code: "DISPOSED" | "DUPLICATE", message: string) {
		super(message);
		this.name = "PluginLifecycleError";
		this.code = code;
	}
}

export const AGENT_HOOK_API_VERSION = 1 as const;
export type AgentHookApiVersion = typeof AGENT_HOOK_API_VERSION;
export type AgentHookPhase =
	| "request_prepare"
	| "pre_step"
	| "request_accept"
	| "tool_execute_before"
	| "step_complete"
	| "turn_complete"
	| "failed"
	| "cancelled";

/** Read-only request data passed to a pre-step modifier. Returning a new assembly is the only way to change it. */
export interface AgentRequestAssembly {
	readonly systemPrompt?: string;
	readonly messages: readonly unknown[];
	readonly tools: readonly unknown[];
}

export interface AgentHookEvent {
	readonly phase: AgentHookPhase;
	readonly assembly?: AgentRequestAssembly;
	readonly event?: unknown;
	readonly error?: unknown;
	readonly message?: unknown;
	readonly toolCall?: unknown;
	readonly toolResult?: unknown;
}

export interface AgentHookContext extends PluginOperationContext {
	readonly apiVersion: AgentHookApiVersion;
	readonly phase: AgentHookPhase;
	readonly turnIndex: number;
	readonly stepIndex: number;
}

export type AgentPreStepDecision =
	| { readonly type: "continue"; readonly assembly: AgentRequestAssembly }
	| { readonly type: "skip"; readonly reason?: string }
	| { readonly type: "abort"; readonly reason?: string };

export interface AgentHookObserver {
	readonly kind: "observer";
	readonly apiVersion?: AgentHookApiVersion;
	readonly phase: AgentHookPhase;
	readonly timeoutMs?: number;
	readonly onError?: "ignore" | "fail";
	readonly run: (event: AgentHookEvent, context: AgentHookContext) => unknown | Promise<unknown>;
}

export interface AgentHookModifier {
	readonly kind: "modifier";
	readonly apiVersion?: AgentHookApiVersion;
	readonly phase: "pre_step";
	readonly timeoutMs?: number;
	readonly onError?: "ignore" | "fail";
	readonly run: (
		event: AgentHookEvent,
		context: AgentHookContext,
	) => AgentPreStepDecision | undefined | Promise<AgentPreStepDecision | undefined>;
}

export type AgentHookRegistration = AgentHookObserver | AgentHookModifier;
/** @deprecated Use AgentHookObserver or AgentHookModifier. */
export type AgentStepPhase = AgentHookPhase;
/** @deprecated Use AgentHookRegistration. */
export type AgentStepHook = AgentHookObserver;

export interface PromptSection {
	readonly name: string;
	readonly order: number;
	readonly text: string;
}

export type ToolPolicyMode = "normal" | "read_only";

export type ToolPolicyErrorCode = "POLICY_DENIED" | "POLICY_CANCELLED" | "POLICY_TIMEOUT" | "POLICY_DISPOSED";

export interface ToolPolicySnapshot {
	readonly mode: ToolPolicyMode;
	readonly revision: number;
	readonly sessionId: string;
}

export interface SessionToolPolicyContext extends PluginOperationContext {
	readonly sessionId: string;
	readonly snapshot: ToolPolicySnapshot;
	readonly projection: unknown;
	readonly pluginState: unknown;
}

/** Host-enforced authorization boundary evaluated immediately before tool execution. */
export interface SessionToolPolicy {
	authorize(toolName: string, parameters: unknown, context: SessionToolPolicyContext): void | Promise<void>;
	readonly snapshot: () => ToolPolicySnapshot;
	readonly setMode: (mode: ToolPolicyMode, context?: PluginOperationContext) => Promise<ToolPolicySnapshot>;
}

export interface UserInteractionRequest {
	readonly requestId: string;
	readonly kind: "question" | "approval" | "choice";
	readonly prompt: string;
	readonly signal: AbortSignal;
}

export interface RpcExtensionDescriptor {
	readonly apiVersion: PluginSdkApiVersion;
	readonly methods: readonly string[];
	readonly events: readonly string[];
}
