import { resolve } from "node:path";
import type { AssistantMessage, ImageContent, Message, Model, Provider, ThinkingLevel } from "@di-code/ai";
import { diagnosticsKey, hostCommandRegistryKey, keybindingRegistryKey, themeRegistryKey } from "@di-code/builtins";
import { type Context, type PluginDefinition, redactSensitiveText } from "@di-code/plugin-runtime";
import { type KeybindingsConfig, ProcessTerminal, type TuiTheme } from "@di-code/tui";
import type { Locale } from "./i18n.ts";
import { runProviderOnboarding, shouldStartProviderOnboarding } from "./provider-onboarding.ts";
import type { InteractiveHostRequest } from "./runtime/interactive-host-service.ts";
import {
	createSessionHost,
	type PromptInput,
	type SessionHost,
	type SessionHostEvent,
	type SessionInfo,
} from "./runtime/session-host.ts";
import { loadStartupConfiguration, resolveStartupRuntime } from "./startup.ts";

/** Version of the stable in-process custom TUI contract. */
export const UI_HOST_API_VERSION = 1 as const;

export type UiHostApiVersion = typeof UI_HOST_API_VERSION;

export type UiHostErrorCode =
	| "INVALID_WORKSPACE"
	| "NOT_FOUND"
	| "BUSY"
	| "SESSION_IN_USE"
	| "DISPOSED"
	| "INVALID_INPUT"
	| "INTERNAL";

/** Errors from SessionHost-owned operations expose a stable code but not internal causes. */
export interface UiHostError extends Error {
	readonly code: UiHostErrorCode;
}

/** Thrown synchronously when a facade is used after host disposal begins. */
export class UiHostLifecycleError extends Error {
	readonly code = "DISPOSED" as const;
	constructor() {
		super("UiHost has been disposed.");
		this.name = "UiHostLifecycleError";
	}
}

export type UiHostEvent = SessionHostEvent;

export interface UiHostSessionSnapshot {
	readonly id: string;
	readonly label: string;
	readonly modifiedAt?: number;
}

export type UiHostOperationKind = "prompt" | "steer" | "retry" | "compact" | "tree" | "session";

/** Read-only Session state that intentionally omits managed paths and internal Session references. */
export interface UiHostSessionState {
	readonly disposed: false;
	readonly activeSession?: UiHostSessionSnapshot;
	readonly busy: boolean;
	readonly operations: readonly { readonly requestId: string; readonly kind: UiHostOperationKind }[];
}

/** Read-only resources selected by product bootstrap for this TUI lifetime. */
export interface UiHostResourceSnapshot {
	readonly models: readonly Model[];
	readonly skills: readonly { readonly name: string; readonly description: string; readonly scope: string }[];
}

export interface UiHostDiagnostics {
	/** Writes redacted diagnostic text to the CLI diagnostic stream. */
	report(message: string): void;
	/** Returns a read-only snapshot of runtime diagnostics known when it is called. */
	snapshot(): readonly { readonly type: string; readonly message?: string; readonly pluginName?: string }[];
}

export interface UiHostThemeRegistry {
	readonly list: () => readonly { readonly name: string; readonly theme: TuiTheme }[];
	/** Registration belongs to the plugin Fiber and is removed during composition disposal. */
	readonly register: (name: string, theme: TuiTheme) => () => void;
}

export interface UiHostKeybindingRegistry {
	readonly snapshot: () => KeybindingsConfig;
	/** Replaces the presentation keybinding snapshot for this composition scope. */
	readonly set: (bindings: KeybindingsConfig) => () => void;
}

/** Product-scoped facilities. It deliberately does not expose command execution or bootstrap service keys. */
export interface ProductHost {
	readonly apiVersion: UiHostApiVersion;
	readonly locale: Locale;
	readonly projectTrusted: boolean;
	readonly resources: () => UiHostResourceSnapshot;
	readonly themes: UiHostThemeRegistry;
	readonly keybindings: UiHostKeybindingRegistry;
	readonly diagnostics: UiHostDiagnostics;
}

/** A lifecycle-checked view over the current product Session, never an AgentSession instance. */
export interface UiSessionHost {
	readonly state: () => UiHostSessionState;
	readonly listSessions: () => Promise<readonly UiHostSessionSnapshot[]>;
	readonly createSession: () => Promise<UiHostSessionSnapshot>;
	readonly openSession: (sessionId: string) => Promise<UiHostSessionSnapshot>;
	readonly closeSession: () => Promise<void>;
	readonly prompt: (input: PromptInput | string, signal?: AbortSignal) => Promise<AssistantMessage>;
	readonly promptWithImages: (
		text: string,
		images: readonly ImageContent[],
		signal?: AbortSignal,
	) => Promise<AssistantMessage>;
	readonly steer: (input: PromptInput | string, signal?: AbortSignal) => Promise<void>;
	readonly steerWithImages: (text: string, images: readonly ImageContent[], signal?: AbortSignal) => Promise<void>;
	readonly retry: (signal?: AbortSignal) => Promise<AssistantMessage>;
	readonly cancel: (requestId: string) => boolean;
	readonly transcript: () => readonly Message[];
	readonly tree: SessionHost["tree"];
	readonly navigateTree: SessionHost["navigateTree"];
	readonly setModel: SessionHost["setModel"];
	readonly setRuntime: (provider: Provider, model: Model) => Model;
	readonly cycleThinkingLevel: () => ThinkingLevel | undefined;
	readonly compact: SessionHost["compact"];
	readonly setCompactionEnabled: SessionHost["setCompactionEnabled"];
	readonly usage: SessionHost["usage"];
	readonly subscribe: SessionHost["subscribe"];
}

/** Stable facade passed to a custom TUI. It becomes unusable as soon as `dispose()` begins. */
export interface UiHost {
	readonly apiVersion: UiHostApiVersion;
	readonly signal: AbortSignal;
	readonly product: ProductHost;
	readonly session: UiSessionHost;
	readonly initialPrompt: string;
	readonly dispose: () => Promise<void>;
}

export interface UiHostStartContext {
	readonly host: UiHost;
	readonly signal: AbortSignal;
}

/**
 * The only callback a replacement interactive host supplies. Resolve when its UI exits; reject to fail startup.
 * The product then aborts in-flight work, releases the Session/MCP resources, and invalidates the facade.
 */
export type UiHostStart = (context: UiHostStartContext) => void | Promise<void>;

function isInteractiveHostRequest(value: unknown): value is InteractiveHostRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"command" in value &&
		typeof value.command === "object" &&
		value.command !== null &&
		"mode" in value.command &&
		value.command.mode === "interactive" &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"agentDir" in value &&
		typeof value.agentDir === "string" &&
		"projectTrusted" in value &&
		typeof value.projectTrusted === "boolean" &&
		"stderr" in value &&
		typeof value.stderr === "function"
	);
}

function snapshotSession(info: SessionInfo): UiHostSessionSnapshot {
	return Object.freeze({
		id: info.id,
		label: info.label,
		...(info.modifiedAt === undefined ? {} : { modifiedAt: info.modifiedAt }),
	});
}

function createUiSession(host: SessionHost, isDisposed: () => boolean): UiSessionHost {
	const assertLive = (): void => {
		if (isDisposed()) throw new UiHostLifecycleError();
	};
	return {
		state: () => {
			assertLive();
			const state = host.state();
			return Object.freeze({
				disposed: false as const,
				...(state.activeSession ? { activeSession: snapshotSession(state.activeSession) } : {}),
				busy: state.busy,
				operations: Object.freeze(
					state.operations.map((operation) =>
						Object.freeze({ requestId: operation.requestId, kind: operation.kind as UiHostOperationKind }),
					),
				),
			});
		},
		listSessions: async () => {
			assertLive();
			return (await host.listSessions()).map(snapshotSession);
		},
		createSession: async () => {
			assertLive();
			return snapshotSession(await host.createSession());
		},
		openSession: async (sessionId) => {
			assertLive();
			return snapshotSession(await host.openSession(sessionId));
		},
		closeSession: async () => {
			assertLive();
			await host.closeSession();
		},
		prompt: (input, signal) => {
			assertLive();
			return host.prompt(input, signal);
		},
		promptWithImages: (text, images, signal) => {
			assertLive();
			return host.promptWithImages(text, images, signal);
		},
		steer: (input, signal) => {
			assertLive();
			return host.steer(input, signal);
		},
		steerWithImages: (text, images, signal) => {
			assertLive();
			return host.steerWithImages(text, images, signal);
		},
		retry: (signal) => {
			assertLive();
			return host.retry(signal);
		},
		cancel: (requestId) => {
			assertLive();
			return host.cancel(requestId);
		},
		transcript: () => {
			assertLive();
			return host.transcript();
		},
		tree: () => {
			assertLive();
			return host.tree();
		},
		navigateTree: (entryId) => {
			assertLive();
			return host.navigateTree(entryId);
		},
		setModel: (modelId) => {
			assertLive();
			return host.setModel(modelId);
		},
		setRuntime: (provider, model) => {
			assertLive();
			return host.setRuntime(provider.id, model.id);
		},
		cycleThinkingLevel: () => {
			assertLive();
			return host.setThinkingLevel();
		},
		compact: (signal) => {
			assertLive();
			return host.compact(signal);
		},
		setCompactionEnabled: (enabled) => {
			assertLive();
			return host.setCompactionEnabled(enabled);
		},
		usage: () => {
			assertLive();
			return host.usage();
		},
		subscribe: (listener) => {
			assertLive();
			return host.subscribe(listener);
		},
	};
}

function createUiHost(
	context: Context,
	request: InteractiveHostRequest,
	host: SessionHost,
	signal: AbortSignal,
	locale: Locale,
): UiHost {
	let disposed = false;
	const assertLive = (): void => {
		if (disposed) throw new UiHostLifecycleError();
	};
	const product: ProductHost = {
		apiVersion: UI_HOST_API_VERSION,
		locale,
		projectTrusted: request.projectTrusted,
		resources: () => {
			assertLive();
			const session = host.ui();
			return Object.freeze({
				models: Object.freeze([...session.availableModels]),
				skills: Object.freeze(
					session.availableSkills.map((skill) =>
						Object.freeze({ name: skill.name, description: skill.description, scope: skill.scope }),
					),
				),
			});
		},
		themes: {
			list: () => {
				assertLive();
				return context.require(themeRegistryKey).list() as readonly {
					readonly name: string;
					readonly theme: TuiTheme;
				}[];
			},
			register: (name, theme) => {
				assertLive();
				return context.require(themeRegistryKey).register(name, theme);
			},
		},
		keybindings: {
			snapshot: () => {
				assertLive();
				return context.require(keybindingRegistryKey).snapshot() as KeybindingsConfig;
			},
			set: (bindings) => {
				assertLive();
				return context.require(keybindingRegistryKey).set(bindings);
			},
		},
		diagnostics: {
			report: (message) => {
				assertLive();
				request.stderr(`${redactSensitiveText(message)}\n`);
			},
			snapshot: () => {
				assertLive();
				return context.require(diagnosticsKey).records.map((record) =>
					Object.freeze({
						type: record.type,
						...(record.message ? { message: redactSensitiveText(record.message) } : {}),
						...(record.pluginName ? { pluginName: record.pluginName } : {}),
					}),
				);
			},
		},
	};
	const api: UiHost = {
		apiVersion: UI_HOST_API_VERSION,
		signal,
		product,
		session: createUiSession(host, () => disposed),
		initialPrompt: request.command.prompt,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await host.dispose();
		},
	};
	return api;
}

async function runUiHost(context: Context, input: unknown, start: UiHostStart, signal?: AbortSignal): Promise<number> {
	if (!isInteractiveHostRequest(input)) throw new TypeError("Interactive host request is invalid");
	const request = input;
	const configuration = await loadStartupConfiguration(request.cwd, process.env, request.agentDir);
	const runtime = shouldStartProviderOnboarding(request.command, true, configuration)
		? await runProviderOnboarding({ configuration, terminal: new ProcessTerminal(), agentDir: request.agentDir })
		: resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
	if (!runtime) return 0;
	const host = await createSessionHost(context, {
		cwd: request.cwd,
		agentDir: request.agentDir,
		projectTrusted: request.projectTrusted,
		noSkills: request.command.noSkills,
		noContextFiles: request.command.noContextFiles,
		skillPaths: request.command.skillPaths,
		provider: runtime.provider,
		model: runtime.model,
		signal,
		...(request.command.sessionPath ? { initialSessionPath: resolve(request.cwd, request.command.sessionPath) } : {}),
	});
	if (!host.state().activeSession) await host.createSession();
	const ui = createUiHost(context, request, host, signal ?? new AbortController().signal, configuration.locale ?? "en");
	try {
		const started = Promise.resolve(start({ host: ui, signal: ui.signal }));
		if (signal === undefined) await started;
		else {
			let onAbort: (() => void) | undefined;
			const cancelled = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([started, cancelled]);
			} finally {
				if (onAbort) signal.removeEventListener("abort", onAbort);
			}
		}
		return 0;
	} finally {
		await ui.dispose();
	}
}

/**
 * Creates a composition entry that replaces `interactive-host` without granting command-registry access.
 * The returned entry owns the product bootstrap and always disposes its UiHost after `start` settles.
 */
export function createUiHostEntry(start: UiHostStart): PluginDefinition {
	return {
		apiVersion: UI_HOST_API_VERSION,
		name: "ui-host",
		apply: (context, _config, fiber) => {
			const registry = context.require(hostCommandRegistryKey);
			fiber.addDisposer(registry.register("interactive", (input, signal) => runUiHost(context, input, start, signal)));
		},
	};
}
