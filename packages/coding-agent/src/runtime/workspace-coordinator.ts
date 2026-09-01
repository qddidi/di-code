import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent, Model, Provider } from "@di-code/ai";
import type { Context } from "@di-code/plugin-runtime";
import type { SessionTreeNode } from "../core/session/types.ts";
import type { AgentSessionCompactionOptions, AgentSessionEvent, SessionUsage } from "../core/session.ts";
import {
	createSessionHost,
	type PromptInput,
	type RequestId,
	type SessionHost,
	type SessionHostBootstrapOptions,
	SessionHostError,
	type SessionId,
	type SessionInfo,
	type SessionSnapshot,
} from "./session-host.ts";

export type RunId = string & { readonly __runId: unique symbol };

export interface RunContext {
	readonly sessionId: SessionId;
	readonly runId: RunId;
	readonly requestId: RequestId;
	readonly toolCallId?: string;
}

export type RunKind = "primary" | "subagent" | "compaction";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Run {
	readonly context: RunContext;
	readonly kind: RunKind;
	readonly parentRunId?: RunId;
	readonly controller: AbortController;
	status: RunStatus;
}

export interface SessionRuntime {
	readonly sessionId: SessionId;
	readonly manager: SessionHost;
	readonly agent: SessionHost;
	readonly runs: Map<RunId, Run>;
	readonly unlock: () => Promise<void>;
	unsubscribe: () => void;
	readonly dispose: () => Promise<void>;
}

export interface WorkspaceResources {
	readonly generation: number;
	/** MCP clients are runtime-owned because the client protocol has no shared-call proof. */
	readonly mcpOwnership: "runtime-exclusive";
}

export interface WorkspaceCoordinatorOptions extends SessionHostBootstrapOptions {
	readonly principal?: string;
}

export interface RunHandle<T> {
	readonly context: RunContext;
	readonly run: Run;
	readonly result: Promise<T>;
}

function asSessionId(value: string): SessionId {
	return value as SessionId;
}
function asRunId(value: string): RunId {
	return value as RunId;
}
function asRequestId(value: string): RequestId {
	return value as RequestId;
}

/**
 * Coordinates independent SessionHost instances for one principal/workspace.
 * SessionHost remains the per-runtime owner of Agent, JSONL lock and MCP connection.
 */
export class WorkspaceCoordinator {
	readonly resources: WorkspaceResources = { generation: 1, mcpOwnership: "runtime-exclusive" };
	private readonly runtimes = new Map<SessionId, SessionRuntime>();
	private readonly listeners = new Set<
		(event: AgentSessionEvent & { readonly sessionId: SessionId; readonly runId?: RunId }) => void
	>();
	private disposed = false;
	private readonly context: Context;
	private readonly options: WorkspaceCoordinatorOptions;

	constructor(context: Context, options: WorkspaceCoordinatorOptions) {
		this.context = context;
		this.options = options;
	}

	private ensureOpen(): void {
		if (this.disposed) throw new SessionHostError("DISPOSED", "WorkspaceCoordinator has been disposed.");
	}

	private runtime(sessionId: string): SessionRuntime {
		const runtime = this.runtimes.get(asSessionId(sessionId));
		if (!runtime) throw new SessionHostError("NOT_FOUND", `Session not found: "${sessionId}".`);
		return runtime;
	}

	private registerRuntime(id: SessionId, host: SessionHost): SessionRuntime {
		const runtime: SessionRuntime = {
			sessionId: id,
			manager: host,
			agent: host,
			runs: new Map(),
			unlock: async () => undefined,
			unsubscribe: () => undefined,
			dispose: async () => {
				for (const run of runtime.runs.values()) if (!isTerminal(run.status)) run.controller.abort();
				runtime.unsubscribe();
				await host.dispose();
				runtime.runs.clear();
			},
		};
		runtime.unsubscribe = host.subscribe((event) => {
			for (const listener of this.listeners)
				try {
					listener({ ...event, sessionId: id } as AgentSessionEvent & {
						readonly sessionId: SessionId;
						readonly runId?: RunId;
					});
				} catch {
					// Observers cannot affect runtime execution.
				}
		});
		this.runtimes.set(id, runtime);
		return runtime;
	}

	private async loadRuntime(
		sessionId: string,
		open: (host: SessionHost) => Promise<SessionInfo>,
	): Promise<SessionRuntime> {
		this.ensureOpen();
		const id = asSessionId(sessionId);
		const existing = this.runtimes.get(id);
		if (existing) return existing;
		const host = await createSessionHost(this.context, this.options);
		try {
			await open(host);
			return this.registerRuntime(id, host);
		} catch (cause) {
			await host.dispose().catch(() => undefined);
			throw cause;
		}
	}

	async createSession(): Promise<SessionInfo> {
		this.ensureOpen();
		const host = await createSessionHost(this.context, this.options);
		try {
			const info = await host.createSession();
			this.registerRuntime(asSessionId(info.id), host);
			return info;
		} catch (cause) {
			await host.dispose().catch(() => undefined);
			throw cause;
		}
	}

	async openSession(sessionId: string): Promise<SessionInfo> {
		const id = asSessionId(sessionId);
		const existing = this.runtimes.get(id);
		if (existing)
			return (
				(await existing.agent.listSessions()).find((item) => String(item.id) === sessionId) ??
				(await existing.agent.openSession(sessionId))
			);
		const runtime = await this.loadRuntime(sessionId, (host) => host.openSession(sessionId));
		return (
			(await runtime.agent.listSessions()).find((item) => String(item.id) === sessionId) ??
			runtime.agent.openSession(sessionId)
		);
	}

	async listSessions(): Promise<readonly SessionInfo[]> {
		this.ensureOpen();
		const host = await createSessionHost(this.context, this.options);
		try {
			return await host.listSessions();
		} finally {
			await host.dispose();
		}
	}

	async inspectSession(sessionId: string): Promise<SessionSnapshot> {
		this.ensureOpen();
		const runtime = this.runtimes.get(asSessionId(sessionId));
		if (runtime) return runtime.agent.inspectSession(sessionId);
		const host = await createSessionHost(this.context, this.options);
		try {
			return await host.inspectSession(sessionId);
		} finally {
			await host.dispose();
		}
	}

	startPrompt(sessionId: string, input: PromptInput | string, signal?: AbortSignal): RunHandle<AssistantMessage> {
		const requestId = typeof input === "string" ? undefined : input.requestId;
		return this.startPrimary(sessionId, "primary", requestId, signal, (runtime, runSignal) =>
			runtime.agent.prompt(input, runSignal),
		);
	}

	startPromptWithImages(
		sessionId: string,
		text: string,
		images: readonly ImageContent[],
		signal?: AbortSignal,
	): RunHandle<AssistantMessage> {
		return this.startPrimary(sessionId, "primary", undefined, signal, (runtime, runSignal) =>
			runtime.agent.promptWithImages(text, images, runSignal),
		);
	}

	startRetry(sessionId: string, targetRequestId: string, signal?: AbortSignal): RunHandle<AssistantMessage> {
		return this.startPrimary(sessionId, "primary", targetRequestId, signal, (runtime, runSignal) =>
			runtime.agent.retry({ targetRequestId }, runSignal),
		);
	}

	startCompact(sessionId: string, signal?: AbortSignal): RunHandle<void> {
		return this.startPrimary(sessionId, "compaction", undefined, signal, (runtime, runSignal) =>
			runtime.agent.compact(runSignal),
		);
	}

	steer(context: RunContext, text: string, signal?: AbortSignal): Promise<void> {
		const runtime = this.runtime(context.sessionId);
		const run = runtime.runs.get(context.runId);
		if (!run || isTerminal(run.status)) throw new SessionHostError("INVALID_INPUT", "Run is not active.");
		return runtime.agent.steer({ text, requestId: context.requestId }, signal);
	}

	cancel(sessionId: string, runId: string): boolean {
		const runtime = this.runtimes.get(asSessionId(sessionId));
		const run = runtime?.runs.get(asRunId(runId));
		if (!run || isTerminal(run.status)) return false;
		run.controller.abort();
		run.status = "cancelled";
		runtime?.agent.cancel(run.context.requestId);
		return true;
	}

	getOperation(sessionId: string, runId: string): Run | undefined {
		return this.runtimes.get(asSessionId(sessionId))?.runs.get(asRunId(runId));
	}

	getRuntime(sessionId: string): SessionRuntime {
		return this.runtime(sessionId);
	}

	subscribe(
		listener: (event: AgentSessionEvent & { readonly sessionId: SessionId; readonly runId?: RunId }) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
		this.listeners.clear();
	}

	private startPrimary<T>(
		sessionId: string,
		kind: RunKind,
		requestedRequestId: string | undefined,
		signal: AbortSignal | undefined,
		action: (runtime: SessionRuntime, signal: AbortSignal) => Promise<T>,
	): RunHandle<T> {
		this.ensureOpen();
		const runtime = this.runtime(sessionId);
		for (const run of runtime.runs.values())
			if (run.kind === "primary" && !isTerminal(run.status))
				throw new SessionHostError("BUSY", "Session already has a primary run.");
		if (
			kind === "compaction" &&
			[...runtime.runs.values()].some((run) => run.kind === "compaction" && !isTerminal(run.status))
		)
			throw new SessionHostError("BUSY", "Session already has a compaction run.");
		if (
			kind === "compaction" &&
			[...runtime.runs.values()].some((run) => run.kind === "primary" && !isTerminal(run.status))
		)
			throw new SessionHostError("BUSY", "Cannot compact while a primary run is active.");
		const runId = asRunId(randomUUID());
		const requestId = asRequestId(requestedRequestId?.trim() || randomUUID());
		const controller = new AbortController();
		const run: Run = {
			context: { sessionId: asSessionId(sessionId), runId, requestId },
			kind,
			controller,
			status: "queued",
		};
		runtime.runs.set(runId, run);
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		run.status = "running";
		const result = action(runtime, controller.signal)
			.then(
				(value) => {
					run.status = controller.signal.aborted ? "cancelled" : "completed";
					return value;
				},
				(cause) => {
					run.status = controller.signal.aborted ? "cancelled" : "failed";
					throw cause;
				},
			)
			.finally(() => signal?.removeEventListener("abort", abort));
		return { context: run.context, run, result };
	}
}

/** Creates a coordinator whose runtimes are loaded on demand per session. */
export async function createWorkspaceCoordinator(
	context: Context,
	options: WorkspaceCoordinatorOptions,
): Promise<WorkspaceCoordinator> {
	return new WorkspaceCoordinator(context, options);
}

function isTerminal(status: RunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

export type { AgentSessionEvent, AgentSessionCompactionOptions, Model, Provider, SessionUsage, SessionTreeNode };
