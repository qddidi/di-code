import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { AssistantMessage, ImageContent, Message, Model, Provider, ThinkingLevel } from "@di-code/ai";
import {
	agentSessionKey,
	providerRegistryKey,
	runtimeSelectionKey,
	sessionStoreRegistryKey,
	type ToolApprovalCapability,
	type ToolPolicyMode,
	type ToolPolicySnapshot,
} from "@di-code/builtins";
import type { Context } from "@di-code/plugin-runtime";
import type { UserInteraction } from "@di-code/plugin-sdk";
import { SessionManager } from "../core/session/session-manager.ts";
import type { SessionTreeNode } from "../core/session/types.ts";
import {
	AgentSession,
	type AgentSessionCompactionOptions,
	type AgentSessionEvent,
	type AgentSessionTool,
	type SessionUsage,
	type TreeNavigationResult,
} from "../core/session.ts";
import { workspaceStorageKey } from "../core/user-data.ts";
import { mcpClientServiceKey, mcpConfigServiceKey, mcpToolServiceKey } from "../mcp/entries.ts";
import { interactiveResourceServiceKey } from "./interactive-resource-service.ts";

export type SessionId = string & { readonly __sessionId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };

export interface SessionInfo {
	readonly id: SessionId;
	readonly displayId?: string;
	readonly cwd: string;
	readonly label: string;
	readonly modifiedAt?: number;
	readonly stats?: SessionStats;
}

export interface SessionStats {
	readonly entryCount: number;
	readonly messageCount: number;
	readonly branchCount: number;
}

export interface SessionSnapshot {
	readonly session: SessionInfo;
	readonly transcript: readonly Message[];
	readonly tree: readonly SessionTreeNode[];
	readonly stats: SessionStats;
	readonly readOnly: true;
	readonly events?: readonly import("../core/session/types.ts").SessionEventEntry[];
}

export interface SessionHostState {
	readonly disposed: boolean;
	readonly workspace: string;
	readonly activeSession?: SessionInfo;
	readonly busy: boolean;
	readonly operations: readonly { readonly requestId: RequestId; readonly kind: SessionOperationKind }[];
}

export type SessionOperationKind = "prompt" | "steer" | "retry" | "compact" | "tree" | "session";
export type SessionHostEvent = AgentSessionEvent | { readonly type: "session_changed"; readonly session?: SessionInfo };
export type SessionHostListener = (event: SessionHostEvent) => void | Promise<void>;

export interface PromptInput {
	readonly text: string;
	readonly requestId?: string;
}

export interface RetryInput {
	readonly targetRequestId: string;
}

export interface SessionHostBootstrapOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted?: boolean;
	readonly noSkills?: boolean;
	readonly noContextFiles?: boolean;
	readonly skillPaths?: readonly string[];
	readonly provider?: Provider;
	readonly model?: Model;
	readonly signal?: AbortSignal;
	readonly compaction?: AgentSessionCompactionOptions;
	/** Per-host approval boundary captured by each created AgentSession. */
	readonly toolApproval?: ToolApprovalCapability;
	readonly toolPolicy?: import("@di-code/builtins").ToolPolicyCapability;
	/** Structured user interaction boundary for session-scoped tools. */
	readonly interaction?: UserInteraction;
	readonly planMode?: { readonly section: string };
	/** Optional managed JSONL file to open before the host is returned. */
	readonly initialSessionPath?: string;
}

export interface SessionHost {
	readonly state: () => SessionHostState;
	readonly listSessions: () => Promise<readonly SessionInfo[]>;
	readonly createSession: () => Promise<SessionInfo>;
	readonly openSession: (sessionId: string) => Promise<SessionInfo>;
	readonly inspectSession: (sessionId: string) => Promise<SessionSnapshot>;
	readonly renameSession: (sessionId: string, label: string) => Promise<SessionInfo>;
	readonly deleteSession: (sessionId: string, confirmation: string) => Promise<void>;
	readonly branchSession: (sessionId?: string, entryId?: string) => Promise<SessionInfo>;
	readonly closeSession: () => Promise<void>;
	readonly prompt: (input: PromptInput | string, signal?: AbortSignal) => Promise<AssistantMessage>;
	readonly promptWithImages: (
		text: string,
		images: readonly ImageContent[],
		signal?: AbortSignal,
	) => Promise<AssistantMessage>;
	readonly steer: (input: PromptInput | string, signal?: AbortSignal) => Promise<void>;
	readonly steerWithImages: (text: string, images: readonly ImageContent[], signal?: AbortSignal) => Promise<void>;
	readonly retry: (input?: RetryInput | AbortSignal, signal?: AbortSignal) => Promise<AssistantMessage>;
	readonly cancel: (requestId: string) => boolean;
	readonly transcript: () => readonly import("@di-code/ai").Message[];
	readonly tree: () => readonly SessionTreeNode[];
	readonly navigateTree: (entryId: string) => Promise<TreeNavigationResult>;
	readonly setModel: (modelId: string) => Model;
	readonly setRuntime: (providerId: string, modelId: string) => Model;
	/** Applies an already-resolved runtime without requiring it in the registry. */
	readonly setRuntimeValue: (provider: Provider, model: Model) => Model;
	readonly setThinkingLevel: (level: ThinkingLevel) => ThinkingLevel;
	readonly cycleThinkingLevel: () => ThinkingLevel | undefined;
	readonly compact: (signal?: AbortSignal) => Promise<void>;
	readonly setCompactionEnabled: (enabled: boolean) => boolean;
	/** Reloads Skills, context and MCP tools after an explicit product-configuration change. */
	readonly refreshResources: (projectTrusted?: boolean, signal?: AbortSignal) => Promise<void>;
	readonly usage: () => SessionUsage;
	readonly toolPolicy: () => ToolPolicySnapshot | undefined;
	readonly setToolPolicyMode: (mode: ToolPolicyMode, signal?: AbortSignal) => Promise<ToolPolicySnapshot>;
	readonly planMode: () => import("@di-code/plan-mode").PlanModeProjection | undefined;
	readonly projections: () => readonly import("@di-code/plugin-sdk").SessionProjectionSnapshot[];
	readonly extensions: () => import("@di-code/plugin-sdk").SessionExtensionFacade | undefined;
	readonly planCommand: (args: string) => Promise<string>;
	readonly ui: () => SessionHostUi;
	readonly subscribe: (listener: SessionHostListener) => () => void;
	readonly dispose: () => Promise<void>;
}

const RETRY_PLUGIN_ID = "di-code.retry";
const RETRY_PLUGIN_VERSION = "1";
const RETRY_PLUGIN_SCHEMA_VERSION = 1;
interface FailedPrompt {
	readonly requestId: string;
	readonly text: string;
}

/** Internal presentation facade. It exposes snapshots and host-owned operations, never Session internals. */
export interface SessionHostUi {
	readonly allowedRoot: string;
	readonly modelId: string;
	readonly providerId: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly availableModels: readonly Model[];
	readonly availableSkills: readonly import("../core/resources/types.ts").SkillResource[];
	readonly compactionEnabled: boolean;
	readonly sessionFile?: string;
	readonly sessionTree: readonly SessionTreeNode[];
	readonly sessionLeafId?: string;
	readonly transcript: readonly Message[];
	readonly usage: SessionUsage;
	readonly promptWithImages: SessionHost["promptWithImages"];
	readonly retry: SessionHost["retry"];
	readonly steerWithImages: SessionHost["steerWithImages"];
	readonly subscribeSession: (listener: (event: AgentSessionEvent) => void | Promise<void>) => () => void;
	readonly setModel: SessionHost["setModel"];
	readonly setRuntime: (provider: Provider, model: Model) => Model;
	readonly cycleThinkingLevel: SessionHost["cycleThinkingLevel"];
	readonly setCompactionEnabled: SessionHost["setCompactionEnabled"];
	readonly navigateTree: SessionHost["navigateTree"];
	readonly compact: SessionHost["compact"];
	readonly planMode: SessionHost["planMode"];
	readonly projections: SessionHost["projections"];
	readonly extensions: SessionHost["extensions"];
	readonly planCommand: SessionHost["planCommand"];
}

export class SessionHostError extends Error {
	readonly code:
		| "INVALID_WORKSPACE"
		| "NOT_FOUND"
		| "BUSY"
		| "SESSION_IN_USE"
		| "DISPOSED"
		| "INVALID_INPUT"
		| "INTERNAL";
	constructor(code: SessionHostError["code"], message: string, options?: { readonly cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "SessionHostError";
		this.code = code;
	}
}

interface Operation {
	readonly controller: AbortController;
	readonly kind: SessionOperationKind;
	promise?: Promise<unknown>;
}

interface HostInternals {
	readonly workspace: string;
	readonly sessionDirectory: string;
	readonly provider: Provider;
	readonly model: Model;
	readonly skills: readonly import("../core/resources/types.ts").SkillResource[];
	readonly systemPrompt: string;
	readonly externalTools: readonly AgentSessionTool[];
	readonly closeMcp: () => Promise<void>;
}

async function validateDataRoot(path: string): Promise<string> {
	const requested = resolve(path);
	await mkdir(requested, { recursive: true });
	const stats = await lstat(requested);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new SessionHostError("INVALID_WORKSPACE", `Agent data root must be a real directory: "${requested}".`);
	}
	const root = await realpath(requested);
	await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
	return root;
}

async function ensureRealChildDirectory(parent: string, name: string): Promise<string> {
	const path = join(parent, name);
	try {
		const stats = await lstat(path);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new SessionHostError("INVALID_WORKSPACE", `Managed data path must be a real directory: "${path}".`);
		}
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		await mkdir(path);
	}
	const real = await realpath(path);
	if (dirname(real) !== parent)
		throw new SessionHostError("INVALID_WORKSPACE", `Managed data path escaped its parent: "${path}".`);
	return real;
}

function asId(value: string): SessionId {
	return value as SessionId;
}

function asRequestId(value: string): RequestId {
	return value as RequestId;
}

function messageText(message: import("@di-code/ai").Message): string {
	if (message.role !== "user") return "";
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join(" ")
		.trim();
}

function sessionLabel(manager: SessionManager): string {
	for (const entry of [...manager.entries].reverse()) {
		if (entry.type !== "plugin" || entry.pluginId !== "di-code.session-label") continue;
		const data = entry.data;
		if (
			typeof data === "object" &&
			data !== null &&
			!Array.isArray(data) &&
			typeof (data as Record<string, unknown>).label === "string"
		) {
			const label = (data as Record<string, unknown>).label as string;
			if (label.trim()) return label;
		}
	}
	const first = manager.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	return first?.type === "message"
		? messageText(first.message) || basename(manager.filePath, extname(manager.filePath))
		: basename(manager.filePath, extname(manager.filePath));
}

async function validateWorkspace(cwd: string): Promise<string> {
	const requested = resolve(cwd);
	let root: string;
	try {
		const stats = await lstat(requested);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Workspace must be a real directory.");
		root = await realpath(requested);
		await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
	} catch (cause) {
		throw new SessionHostError("INVALID_WORKSPACE", `Workspace is not an accessible real directory: "${requested}".`, {
			cause,
		});
	}
	return root;
}

async function lockSession(filePath: string): Promise<() => Promise<void>> {
	const lockPath = `${filePath}.host.lock`;
	const token = `${process.pid}:${randomUUID()}`;
	try {
		const handle = await open(lockPath, "wx");
		await handle.writeFile(token, "utf8");
		return async () => {
			let releaseError: unknown;
			try {
				const owner = await readFile(lockPath, "utf8");
				if (owner !== token) releaseError = new Error(`Session lock ownership changed: "${lockPath}".`);
			} catch (cause) {
				if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) releaseError = cause;
			}
			try {
				await handle.close();
			} catch (cause) {
				releaseError = cause;
			}
			if (releaseError === undefined) {
				try {
					await unlink(lockPath);
				} catch (cause) {
					if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) releaseError = cause;
				}
			}
			if (releaseError !== undefined) throw releaseError;
		};
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
			try {
				const owner = await readFile(lockPath, "utf8");
				const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
				if (Number.isSafeInteger(ownerPid) && ownerPid > 0) process.kill(ownerPid, 0);
			} catch (ownerCause) {
				if (ownerCause instanceof Error && "code" in ownerCause && ownerCause.code === "ESRCH") {
					const stalePath = `${lockPath}.stale-${randomUUID()}`;
					try {
						await rename(lockPath, stalePath);
						await unlink(stalePath);
						return await lockSession(filePath);
					} catch (reclaimCause) {
						if (reclaimCause instanceof Error && "code" in reclaimCause && reclaimCause.code === "ENOENT")
							return await lockSession(filePath);
						throw new SessionHostError("INTERNAL", `Unable to reclaim stale Session lock: "${filePath}".`, {
							cause: reclaimCause,
						});
					}
				}
			}
			throw new SessionHostError("SESSION_IN_USE", `Session is already open: "${filePath}".`, { cause });
		}
		throw new SessionHostError("INTERNAL", `Unable to lock session: "${filePath}".`, { cause });
	}
}

async function createBootstrap(context: Context, options: SessionHostBootstrapOptions): Promise<HostInternals> {
	const workspace = await validateWorkspace(options.cwd);
	const agentDir = await validateDataRoot(options.agentDir);
	const sessionsRoot = await ensureRealChildDirectory(agentDir, "sessions");
	// Preserve the CLI's historical workspace hash (which uses the user-supplied path casing/alias).
	const sessionDirectory = await ensureRealChildDirectory(sessionsRoot, workspaceStorageKey(options.cwd));
	const resources = await context.require(interactiveResourceServiceKey).load({
		cwd: workspace,
		agentDir,
		projectTrusted: options.projectTrusted ?? false,
		noSkills: options.noSkills,
		noContextFiles: options.noContextFiles,
		skillPaths: options.skillPaths,
	});
	const runtime =
		options.provider && options.model
			? { provider: options.provider, model: options.model }
			: context.require(runtimeSelectionKey).selected();
	const mcpConfig = context.require(mcpConfigServiceKey);
	const mcpClient = context.require(mcpClientServiceKey);
	const configurations = await mcpConfig.load({ cwd: workspace, projectTrusted: options.projectTrusted ?? false });
	const mcp = await mcpClient.connect(configurations, { signal: options.signal });
	let externalTools: readonly AgentSessionTool[];
	try {
		externalTools = context
			.require(mcpToolServiceKey)
			.create(mcp.servers, ["read", "write", "edit", "glob", "grep", "bash", "load_skill"]);
	} catch (cause) {
		await mcpClient.close(mcp.manager);
		throw cause;
	}
	return {
		workspace,
		sessionDirectory,
		provider: runtime.provider,
		model: runtime.model,
		skills: resources.resources.skills,
		systemPrompt: resources.systemPrompt,
		externalTools,
		closeMcp: () => mcpClient.close(mcp.manager),
	};
}

export async function createSessionHost(context: Context, options: SessionHostBootstrapOptions): Promise<SessionHost> {
	let bootstrap = await createBootstrap(context, options);
	try {
		await mkdir(bootstrap.sessionDirectory, { recursive: true });
	} catch (cause) {
		await bootstrap.closeMcp();
		throw cause;
	}
	const store = context.require(sessionStoreRegistryKey).get("jsonl");
	if (!store) {
		await bootstrap.closeMcp();
		throw new SessionHostError("INTERNAL", "JSONL SessionStore is unavailable.");
	}
	const sessions = new Map<
		SessionId,
		{
			readonly manager: SessionManager;
			readonly session: AgentSession;
			readonly unsubscribe: () => void;
			readonly unlock: () => Promise<void>;
			readonly info: SessionInfo;
		}
	>();
	const operations = new Map<RequestId, Operation>();
	const listeners = new Set<SessionHostListener>();
	let activeId: SessionId | undefined;
	const failedPrompts = new Map<SessionId, FailedPrompt | undefined>();
	let resourceProjectTrusted = options.projectTrusted;
	let disposed = false;

	const ensureOpen = (): void => {
		if (disposed) throw new SessionHostError("DISPOSED", "SessionHost has been disposed.");
	};
	const current = () => {
		if (!activeId) throw new SessionHostError("NOT_FOUND", "No Session is open.");
		const value = sessions.get(activeId);
		if (!value) throw new SessionHostError("NOT_FOUND", "No Session is open.");
		return value;
	};
	const emit = (event: SessionHostEvent): void => {
		for (const listener of listeners) {
			queueMicrotask(() => {
				try {
					Promise.resolve(listener(structuredClone(event))).catch(() => undefined);
				} catch {
					// Observers cannot fail the Agent loop or persistence path.
				}
			});
		}
	};
	const infoFor = (manager: SessionManager): SessionInfo => ({
		id: asId(manager.header.id),
		displayId: basename(manager.filePath, extname(manager.filePath)),
		cwd: manager.header.cwd,
		label: sessionLabel(manager),
		modifiedAt: Date.parse(manager.header.timestamp),
		stats: statsFor(manager),
	});
	const statsFor = (manager: SessionManager): SessionStats => {
		const entries = manager.entries;
		const parentIds = new Set(entries.map((entry) => entry.parentId));
		return {
			entryCount: entries.length,
			messageCount: entries.filter((entry) => entry.type === "message").length,
			branchCount: [...parentIds].filter((parent) => entries.filter((entry) => entry.parentId === parent).length > 1)
				.length,
		};
	};
	const retryState = (manager: SessionManager): FailedPrompt | undefined => {
		for (const entry of [...manager.getBranch()].reverse()) {
			if (
				entry.type !== "plugin" ||
				entry.pluginId !== RETRY_PLUGIN_ID ||
				entry.schemaVersion !== RETRY_PLUGIN_SCHEMA_VERSION
			)
				continue;
			const data = entry.data;
			if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
			const value = data as Record<string, unknown>;
			if (value.active !== true || typeof value.text !== "string" || typeof value.requestId !== "string")
				return undefined;
			return { requestId: value.requestId, text: value.text };
		}
		return undefined;
	};
	const persistRetryState = async (manager: SessionManager, state: FailedPrompt | undefined): Promise<void> => {
		await manager.appendPlugin({
			pluginId: RETRY_PLUGIN_ID,
			pluginVersion: RETRY_PLUGIN_VERSION,
			schemaVersion: RETRY_PLUGIN_SCHEMA_VERSION,
			data: state ? { active: true, requestId: state.requestId, text: state.text } : { active: false },
		});
	};
	const createAgent = async (manager: SessionManager, resources = bootstrap): Promise<AgentSession> => {
		const created = await context.require(agentSessionKey).create({
			// The host owns the workspace boundary. Reading the root from the shared
			// composition context would pin every WebUI actor to the startup folder.
			allowedRoot: resources.workspace,
			provider: resources.provider,
			model: resources.model,
			systemPrompt: resources.systemPrompt,
			skills: resources.skills,
			sessionManager: manager,
			externalTools: resources.externalTools,
			compaction: options.compaction,
			toolApproval: options.toolApproval,
			toolPolicy: options.toolPolicy,
			interaction: options.interaction,
			planMode: options.planMode,
		});
		if (!(created instanceof AgentSession))
			throw new SessionHostError("INTERNAL", "SessionFactory returned an incompatible session.");
		return created;
	};
	const assertIdle = (kind: string): void => {
		if (operations.size > 0)
			throw new SessionHostError("BUSY", `Cannot ${kind} while another Session operation is running.`);
	};
	const withOperation = async <T>(
		kind: SessionOperationKind,
		requestId: string | undefined,
		signal: AbortSignal | undefined,
		action: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		ensureOpen();
		const id = asRequestId(requestId?.trim() || randomUUID());
		if (operations.has(id)) throw new SessionHostError("BUSY", `Request ID is already active: "${id}".`);
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		const operation: Operation = { controller, kind };
		operations.set(id, operation);
		const promise = (async () => {
			try {
				return await action(controller.signal);
			} catch (cause) {
				if (cause instanceof SessionHostError) throw cause;
				if (cause instanceof Error && (cause.name === "AbortError" || controller.signal.aborted)) throw cause;
				throw new SessionHostError("INTERNAL", cause instanceof Error ? cause.message : String(cause), { cause });
			} finally {
				operations.delete(id);
				signal?.removeEventListener("abort", abort);
			}
		})();
		operation.promise = promise;
		return await promise;
	};
	const openManager = async (manager: SessionManager): Promise<SessionInfo> => {
		let sessionWorkspace: string;
		try {
			sessionWorkspace = await realpath(manager.header.cwd);
		} catch (cause) {
			throw new SessionHostError("INVALID_WORKSPACE", "Session workspace is unavailable.", { cause });
		}
		if (sessionWorkspace !== bootstrap.workspace)
			throw new SessionHostError("INVALID_WORKSPACE", "Session workspace does not match the Host workspace.");
		const id = asId(manager.header.id);
		const unlock = await lockSession(manager.filePath);
		try {
			const session = await createAgent(manager);
			const info = infoFor(manager);
			const previous = activeId;
			if (previous !== undefined) {
				const old = sessions.get(previous);
				if (old) {
					old.unsubscribe();
					await old.session.dispose();
					await old.unlock();
				}
				sessions.delete(previous);
			}
			const unsubscribe = session.subscribeSession(emit);
			sessions.set(id, { manager, session, unsubscribe, unlock, info });
			failedPrompts.set(id, retryState(manager));
			activeId = id;
			emit({ type: "session_changed", session: info });
			return info;
		} catch (cause) {
			await unlock();
			throw cause;
		}
	};
	const findSessionPath = async (id: string): Promise<string> => {
		let entries: readonly import("node:fs").Dirent<string>[];
		try {
			entries = await readdir(bootstrap.sessionDirectory, { withFileTypes: true, encoding: "utf8" });
		} catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
				throw new SessionHostError("NOT_FOUND", `Session not found: "${id}".`);
			throw cause;
		}
		const managedDirectory = await realpath(bootstrap.sessionDirectory);
		for (const entry of entries) {
			if (!entry.isFile() || extname(entry.name) !== ".jsonl") continue;
			const path = join(bootstrap.sessionDirectory, entry.name);
			if (dirname(await realpath(path)) !== managedDirectory) continue;
			try {
				const manager = await store.open(path);
				if (manager instanceof SessionManager && manager.header.id === id) return path;
			} catch {
				// Damaged sessions remain listable only through their file diagnostics; they cannot match an opaque ID.
			}
		}
		throw new SessionHostError("NOT_FOUND", `Session not found: "${id}".`);
	};
	const api: SessionHost = {
		state: () => ({
			disposed,
			workspace: bootstrap.workspace,
			activeSession: activeId ? sessions.get(activeId)?.info : undefined,
			busy: operations.size > 0,
			operations: [...operations].map(([requestId, op]) => ({ requestId, kind: op.kind })),
		}),
		listSessions: async () => {
			ensureOpen();
			let entries: readonly import("node:fs").Dirent<string>[] = [];
			try {
				entries = await readdir(bootstrap.sessionDirectory, { withFileTypes: true, encoding: "utf8" });
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
				throw cause;
			}
			const result: SessionInfo[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || extname(entry.name) !== ".jsonl") continue;
				const path = join(bootstrap.sessionDirectory, entry.name);
				const real = await realpath(path);
				if (dirname(real) !== (await realpath(bootstrap.sessionDirectory)))
					throw new SessionHostError("INVALID_WORKSPACE", "Session path escaped its managed directory.");
				const manager = await store.open(path);
				if (!(manager instanceof SessionManager)) continue;
				let managerWorkspace: string;
				try {
					managerWorkspace = await realpath(manager.header.cwd);
				} catch {
					continue;
				}
				if (managerWorkspace.toLowerCase() !== bootstrap.workspace.toLowerCase()) continue;
				result.push(infoFor(manager));
			}
			return result.sort((left, right) => {
				const rightModified = right.modifiedAt ?? 0;
				const leftModified = left.modifiedAt ?? 0;
				return rightModified - leftModified || right.id.localeCompare(left.id);
			});
		},
		createSession: async () => {
			ensureOpen();
			assertIdle("create a Session");
			const manager = await store.create({
				filePath: join(
					bootstrap.sessionDirectory,
					`${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.jsonl`,
				),
				cwd: bootstrap.workspace,
				deferCreate: true,
			});
			if (!(manager instanceof SessionManager))
				throw new SessionHostError("INTERNAL", "JSONL SessionStore returned an incompatible SessionManager.");
			return await openManager(manager);
		},
		openSession: async (id) => {
			ensureOpen();
			assertIdle("open a Session");
			if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id))
				throw new SessionHostError("INVALID_INPUT", "Session ID is invalid.");
			if (activeId === id) return current().info;
			const path = await findSessionPath(id);
			try {
				if ((await lstat(path)).isSymbolicLink()) throw new Error("symlink");
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
					throw new SessionHostError("NOT_FOUND", `Session not found: "${id}".`);
				throw new SessionHostError("INVALID_WORKSPACE", "Session path is not a regular file.", { cause });
			}
			const managedDirectory = await realpath(bootstrap.sessionDirectory);
			if (dirname(await realpath(path)) !== managedDirectory)
				throw new SessionHostError("INVALID_WORKSPACE", "Session path escaped its managed directory.");
			const manager = await store.open(path);
			if (!(manager instanceof SessionManager))
				throw new SessionHostError("INTERNAL", "JSONL SessionStore returned an incompatible SessionManager.");
			return await openManager(manager);
		},
		inspectSession: async (id) => {
			ensureOpen();
			const path = await findSessionPath(id);
			const manager = await store.open(path);
			if (!(manager instanceof SessionManager)) throw new SessionHostError("INTERNAL", "Invalid SessionManager.");
			const info = infoFor(manager);
			return {
				session: info,
				transcript: manager.messages,
				tree: manager.getTree(),
				stats: statsFor(manager),
				readOnly: true,
				events: manager.events,
			};
		},
		renameSession: async (id, label) => {
			ensureOpen();
			assertIdle("rename a Session");
			if (!label.trim() || label.length > 200) throw new SessionHostError("INVALID_INPUT", "Session label is invalid.");
			const path = await findSessionPath(id);
			const manager = await store.open(path);
			if (!(manager instanceof SessionManager)) throw new SessionHostError("INTERNAL", "Invalid SessionManager.");
			const active = sessions.get(asId(id));
			const unlock = active ? undefined : await lockSession(path);
			try {
				await manager.appendPlugin({
					pluginId: "di-code.session-label",
					pluginVersion: "1",
					schemaVersion: 1,
					data: { label: label.trim() },
				});
			} finally {
				if (unlock) await unlock();
			}
			const info = infoFor(manager);
			const existing = sessions.get(asId(id));
			if (existing) sessions.set(asId(id), { ...existing, info });
			return info;
		},
		deleteSession: async (id, confirmation) => {
			ensureOpen();
			assertIdle("delete a Session");
			if (confirmation !== id) throw new SessionHostError("INVALID_INPUT", "Session deletion requires confirmation.");
			if (activeId === id) await api.closeSession();
			const path = await findSessionPath(id);
			const unlock = await lockSession(path);
			try {
				await unlink(path);
			} finally {
				await unlock();
			}
		},
		branchSession: async (id, entryId) => {
			ensureOpen();
			assertIdle("branch a Session");
			const sourceId = id ?? activeId;
			if (!sourceId) throw new SessionHostError("NOT_FOUND", "No Session is open.");
			const sourcePath = await findSessionPath(sourceId);
			const source = await store.open(sourcePath);
			if (!(source instanceof SessionManager)) throw new SessionHostError("INTERNAL", "Invalid SessionManager.");
			const branch = await store.create({
				filePath: join(
					bootstrap.sessionDirectory,
					`${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.jsonl`,
				),
				cwd: bootstrap.workspace,
				deferCreate: true,
			});
			if (!(branch instanceof SessionManager)) throw new SessionHostError("INTERNAL", "Invalid SessionManager.");
			const selected = entryId ? source.getEntry(entryId) : undefined;
			if (entryId && !selected) throw new SessionHostError("NOT_FOUND", "Session tree entry was not found.");
			for (const entry of source.getBranch(entryId ?? source.leafId)) {
				if (entry.type === "message") await branch.appendMessage(entry.message);
				else if (entry.type === "event")
					await branch.appendEvent({
						namespace: entry.namespace,
						eventName: entry.eventName,
						schemaVersion: entry.schemaVersion,
						payload: entry.payload,
					});
			}
			return await openManager(branch);
		},
		closeSession: async () => {
			ensureOpen();
			assertIdle("close the Session");
			if (!activeId) return;
			const value = current();
			sessions.delete(activeId);
			activeId = undefined;
			value.unsubscribe();
			await value.session.dispose();
			await value.unlock();
			emit({ type: "session_changed" });
		},
		prompt: (input, signal) => {
			const parsed = typeof input === "string" ? { text: input } : input;
			if (!parsed.text?.trim())
				return Promise.reject(new SessionHostError("INVALID_INPUT", "Prompt text must not be empty."));
			assertIdle("start a prompt");
			return withOperation("prompt", parsed.requestId, signal, async (operationSignal) => {
				const value = current();
				try {
					const result = await value.session.prompt(parsed.text, operationSignal);
					const failed = result.stopReason === "error" || result.stopReason === "aborted";
					failedPrompts.set(
						value.info.id,
						failed ? { requestId: parsed.requestId ?? "", text: parsed.text } : undefined,
					);
					await persistRetryState(value.manager, failed ? failedPrompts.get(value.info.id) : undefined);
					return result;
				} catch (cause) {
					const failed = { requestId: parsed.requestId ?? "", text: parsed.text };
					failedPrompts.set(value.info.id, failed);
					await persistRetryState(value.manager, failed).catch(() => undefined);
					throw cause;
				}
			});
		},
		promptWithImages: (text, images, signal) => {
			if (!text?.trim()) return Promise.reject(new SessionHostError("INVALID_INPUT", "Prompt text must not be empty."));
			assertIdle("start a prompt");
			return withOperation("prompt", undefined, signal, async (operationSignal) => {
				const value = current();
				try {
					const result = await value.session.promptWithImages(text, images, operationSignal);
					const failed = result.stopReason === "error" || result.stopReason === "aborted";
					const state = failed ? { requestId: randomUUID(), text } : undefined;
					failedPrompts.set(value.info.id, state);
					await persistRetryState(value.manager, state);
					return result;
				} catch (cause) {
					const failed = { requestId: randomUUID(), text };
					failedPrompts.set(value.info.id, failed);
					await persistRetryState(value.manager, failed).catch(() => undefined);
					throw cause;
				}
			});
		},
		steer: (input, signal) => {
			const parsed = typeof input === "string" ? { text: input } : input;
			if (!parsed.text?.trim())
				return Promise.reject(new SessionHostError("INVALID_INPUT", "Steering text must not be empty."));
			return withOperation("steer", parsed.requestId, signal, async (operationSignal) => {
				await current().session.steer(parsed.text, operationSignal);
			});
		},
		steerWithImages: (text, images, signal) =>
			withOperation("steer", undefined, signal, async (operationSignal) => {
				await current().session.steerWithImages(text, images, operationSignal);
			}),
		retry: (input, signal) => {
			ensureOpen();
			assertIdle("retry");
			const target =
				typeof input === "object" && input !== null && !(input instanceof AbortSignal)
					? input.targetRequestId
					: undefined;
			const operationSignal = input instanceof AbortSignal ? input : signal;
			const value = current();
			const retry = failedPrompts.get(value.info.id);
			if (!retry || (target !== undefined && target !== retry.requestId))
				return Promise.reject(new SessionHostError("INVALID_INPUT", "No failed prompt is available to retry."));
			return withOperation("retry", target, operationSignal, async (operationSignal) => {
				const result = await value.session.prompt(retry.text, operationSignal);
				if (result.stopReason === "error" || result.stopReason === "aborted") {
					await persistRetryState(value.manager, retry);
				} else {
					failedPrompts.set(value.info.id, undefined);
					await persistRetryState(value.manager, undefined);
				}
				return result;
			});
		},
		cancel: (id) => {
			const operation = operations.get(asRequestId(id));
			if (!operation) return false;
			operation.controller.abort();
			return true;
		},
		transcript: () => structuredClone(current().session.transcript),
		tree: () => structuredClone(current().session.sessionTree),
		navigateTree: (entryId) => {
			ensureOpen();
			assertIdle("navigate the Session tree");
			return withOperation("tree", undefined, undefined, async () => current().session.navigateTree(entryId));
		},
		setModel: (modelId) => {
			ensureOpen();
			assertIdle("change model");
			return current().session.setModel(modelId);
		},
		setRuntime: (providerId, modelId) => {
			ensureOpen();
			assertIdle("change runtime");
			try {
				const selection = context.require(providerRegistryKey).select(providerId, modelId);
				return api.setRuntimeValue(selection.provider, selection.model);
			} catch (cause) {
				const provider = bootstrap.provider;
				const model =
					provider.id === providerId ? provider.models.find((candidate) => candidate.id === modelId) : undefined;
				if (model) return api.setRuntimeValue(provider, model);
				throw cause;
			}
		},
		setRuntimeValue: (provider, model) => {
			ensureOpen();
			assertIdle("change runtime");
			return current().session.setRuntime(provider, model);
		},
		setThinkingLevel: (level) => {
			ensureOpen();
			assertIdle("change thinking level");
			return current().session.setThinkingLevel(level);
		},
		cycleThinkingLevel: () => {
			ensureOpen();
			assertIdle("change thinking level");
			return current().session.cycleThinkingLevel();
		},
		compact: (signal) => {
			ensureOpen();
			assertIdle("compact the Session");
			return withOperation("compact", undefined, signal, async (operationSignal) =>
				current().session.compact(operationSignal),
			);
		},
		setCompactionEnabled: (enabled) => {
			ensureOpen();
			assertIdle("change compaction");
			return current().session.setCompactionEnabled(enabled);
		},
		refreshResources: (projectTrusted, signal) => {
			ensureOpen();
			assertIdle("refresh product resources");
			return withOperation("session", undefined, signal, async () => {
				const next = await createBootstrap(context, {
					...options,
					projectTrusted: projectTrusted ?? resourceProjectTrusted,
				});
				if (next.workspace !== bootstrap.workspace) {
					await next.closeMcp();
					throw new SessionHostError("INVALID_WORKSPACE", "Product resources changed the Host workspace.");
				}
				const active = activeId === undefined ? undefined : current();
				if (!active) {
					const previous = bootstrap;
					bootstrap = next;
					resourceProjectTrusted = projectTrusted ?? resourceProjectTrusted;
					await previous.closeMcp();
					return;
				}
				try {
					const session = await createAgent(active.manager, next);
					const unsubscribe = session.subscribeSession(emit);
					const previous = bootstrap;
					bootstrap = next;
					resourceProjectTrusted = projectTrusted ?? resourceProjectTrusted;
					sessions.set(active.info.id, { ...active, session, unsubscribe });
					active.unsubscribe();
					await active.session.dispose();
					await previous.closeMcp();
				} catch (cause) {
					await next.closeMcp();
					throw cause;
				}
			});
		},
		usage: () => current().session.usage,
		toolPolicy: () => current().session.toolPolicySnapshot,
		setToolPolicyMode: (mode, signal) => current().session.setToolPolicyMode(mode, signal),
		planMode: () => current().session.planModeProjection,
		projections: () => current().session.projections(),
		extensions: () => current().session.extensions(),
		planCommand: (args) => current().session.planModeCommand(args),
		ui: () => {
			const session = current().session;
			return {
				get allowedRoot() {
					return session.allowedRoot;
				},
				get modelId() {
					return session.modelId;
				},
				get providerId() {
					return session.providerId;
				},
				get thinkingLevel() {
					return session.thinkingLevel;
				},
				get availableModels() {
					return session.availableModels;
				},
				get availableSkills() {
					return session.availableSkills;
				},
				get compactionEnabled() {
					return session.compactionEnabled;
				},
				get sessionFile() {
					return session.sessionFile;
				},
				get sessionTree() {
					return session.sessionTree;
				},
				get sessionLeafId() {
					return session.sessionLeafId;
				},
				get transcript() {
					return session.transcript;
				},
				get usage() {
					return session.usage;
				},
				promptWithImages: api.promptWithImages,
				retry: api.retry,
				steerWithImages: api.steerWithImages,
				subscribeSession: (listener) =>
					api.subscribe((event) => {
						if (event.type !== "session_changed") return listener(event);
					}),
				setModel: api.setModel,
				setRuntime: (provider, model) => api.setRuntime(provider.id, model.id),
				cycleThinkingLevel: api.cycleThinkingLevel,
				setCompactionEnabled: api.setCompactionEnabled,
				navigateTree: api.navigateTree,
				compact: api.compact,
				planMode: api.planMode,
				projections: api.projections,
				extensions: api.extensions,
				planCommand: api.planCommand,
			} satisfies SessionHostUi;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			const pending = [...operations.values()]
				.map((operation) => operation.promise)
				.filter((promise): promise is Promise<unknown> => promise !== undefined);
			for (const operation of operations.values()) operation.controller.abort();
			await Promise.allSettled(pending);
			for (const value of sessions.values()) {
				value.unsubscribe();
				await value.session.dispose();
				await value.unlock();
			}
			sessions.clear();
			failedPrompts.clear();
			activeId = undefined;
			listeners.clear();
			await bootstrap.closeMcp();
		},
	};
	if (options.initialSessionPath !== undefined) {
		const initialPath = resolve(options.initialSessionPath);
		if (dirname(await realpath(initialPath)) !== (await realpath(bootstrap.sessionDirectory)))
			throw new SessionHostError("INVALID_WORKSPACE", "Initial Session path escaped its managed directory.");
		const initial = await store.open(initialPath);
		if (!(initial instanceof SessionManager))
			throw new SessionHostError("INTERNAL", "JSONL SessionStore returned an incompatible SessionManager.");
		await openManager(initial);
	}
	return api;
}

export interface SessionActor extends SessionHost {
	readonly principal: string;
	readonly workspace: string;
}
export interface HostManagerOptions extends SessionHostBootstrapOptions {
	readonly principal: string;
}

export class HostManager {
	private readonly actors = new Map<string, SessionActor>();
	private disposed = false;
	private readonly context: Context;
	constructor(context: Context) {
		this.context = context;
	}
	async get(options: HostManagerOptions): Promise<SessionActor> {
		if (this.disposed) throw new SessionHostError("DISPOSED", "HostManager has been disposed.");
		const workspace = await validateWorkspace(options.cwd);
		const key = `${options.principal}\n${workspace}`;
		const existing = this.actors.get(key);
		if (existing) return existing;
		const host = await createSessionHost(this.context, { ...options, cwd: workspace });
		const actor = Object.assign(host, { principal: options.principal, workspace });
		this.actors.set(key, actor);
		return actor;
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await Promise.all([...this.actors.values()].map((actor) => actor.dispose()));
		this.actors.clear();
	}
}
