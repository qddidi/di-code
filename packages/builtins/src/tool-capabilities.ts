import type { AgentTool, AgentToolResult } from "@di-code/agent";
import type { ImageGenerationProvider, TSchema } from "@di-code/ai";
import type { SkillCatalog } from "@di-code/skills";
import type { BashOperations } from "./tool-bash-implementation.ts";

/** Workspace-scoped filesystem boundary supplied to built-in file tools. */
export interface WorkspaceCapability {
	readonly allowedRoot: string;
}

/** Process execution boundary supplied to the bash tool. */
export interface ProcessCapability {
	readonly bashOperations?: BashOperations;
}

/** Reserved for tools that need a network client in a later composition stage. */
export interface NetworkCapability {
	readonly available: boolean;
}

export interface ImageGenerationCapability {
	readonly provider: ImageGenerationProvider;
	readonly artifactDirectory: string;
}

export interface ToolPolicyCapability {
	authorize(toolName: string, parameters: unknown, signal?: AbortSignal): void | Promise<void>;
	readonly snapshot?: () => ToolPolicySnapshot;
	readonly setMode?: (mode: ToolPolicyMode, signal?: AbortSignal) => Promise<ToolPolicySnapshot>;
	readonly dispose?: () => void;
}

export type ToolPolicyMode = "normal" | "read_only";

export interface ToolPolicySnapshot {
	readonly mode: ToolPolicyMode;
	readonly revision: number;
	readonly sessionId?: string;
}

export type ToolPolicyErrorCode = "POLICY_DENIED" | "POLICY_CANCELLED" | "POLICY_TIMEOUT" | "POLICY_DISPOSED";

export class ToolPolicyError extends Error {
	readonly code: ToolPolicyErrorCode;
	readonly toolName?: string;
	constructor(
		code: ToolPolicyErrorCode,
		message: string,
		options?: { readonly toolName?: string; readonly cause?: unknown },
	) {
		super(message, { cause: options?.cause });
		this.name = "ToolPolicyError";
		this.code = code;
		this.toolName = options?.toolName;
	}
}

export interface SessionToolPolicyOptions {
	readonly sessionId: string;
	readonly initialMode?: ToolPolicyMode;
	readonly projection?: () => unknown;
	readonly pluginState?: () => unknown;
	readonly persistMode?: (mode: ToolPolicyMode, signal?: AbortSignal) => Promise<void>;
	readonly timeoutMs?: number;
}

export const TOOL_POLICY_EVENT_NAMESPACE = "di-code.tool-policy";
export const TOOL_POLICY_EVENT_NAME = "mode_changed";
export const TOOL_POLICY_EVENT_SCHEMA_VERSION = 1 as const;

export function isMutationToolName(toolName: string): boolean {
	return toolName === "write" || toolName === "edit" || toolName === "bash";
}

export function createSessionToolPolicy(options: SessionToolPolicyOptions): ToolPolicyCapability {
	if (!options.sessionId.trim()) throw new TypeError("Session tool policy sessionId must not be empty.");
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0))
		throw new RangeError("Session tool policy timeoutMs must be a non-negative finite number.");
	let mode: ToolPolicyMode = options.initialMode ?? "normal";
	let revision = 0;
	let disposed = false;
	let changeQueue: Promise<unknown> = Promise.resolve();
	const snapshot = (): ToolPolicySnapshot => Object.freeze({ mode, revision, sessionId: options.sessionId });
	const authorize = (toolName: string, _parameters: unknown, signal?: AbortSignal): void => {
		if (disposed) throw new ToolPolicyError("POLICY_DISPOSED", "Session tool policy has been disposed.", { toolName });
		if (signal?.aborted)
			throw new ToolPolicyError("POLICY_CANCELLED", "Tool authorization was cancelled.", {
				toolName,
				cause: signal.reason,
			});
		const current = snapshot();
		// Policy is checked at the execution boundary. Prompt text and catalog visibility are not authorization.
		if (current.mode === "read_only" && isMutationToolName(toolName)) {
			throw new ToolPolicyError("POLICY_DENIED", `Tool "${toolName}" is not allowed in read-only mode.`, { toolName });
		}
		void options.projection?.();
		void options.pluginState?.();
	};
	const setMode = (nextMode: ToolPolicyMode, signal?: AbortSignal): Promise<ToolPolicySnapshot> => {
		if (nextMode !== "normal" && nextMode !== "read_only")
			return Promise.reject(new TypeError(`Unsupported tool policy mode: ${String(nextMode)}`));
		const operation = changeQueue.then(async () => {
			if (disposed) throw new ToolPolicyError("POLICY_DISPOSED", "Session tool policy has been disposed.");
			if (signal?.aborted)
				throw new ToolPolicyError("POLICY_CANCELLED", "Tool policy change was cancelled.", { cause: signal.reason });
			if (nextMode === mode) return snapshot();
			if (options.persistMode) {
				const persistence = options.persistMode(nextMode, signal);
				const cancellation = signal
					? new Promise<never>((_, reject) => {
							if (signal.aborted) {
								reject(
									new ToolPolicyError("POLICY_CANCELLED", "Tool policy change was cancelled.", {
										cause: signal.reason,
									}),
								);
								return;
							}
							const onAbort = () =>
								reject(
									new ToolPolicyError("POLICY_CANCELLED", "Tool policy change was cancelled.", {
										cause: signal.reason,
									}),
								);
							signal.addEventListener("abort", onAbort, { once: true });
							void persistence.then(
								() => signal.removeEventListener("abort", onAbort),
								() => signal.removeEventListener("abort", onAbort),
							);
						})
					: undefined;
				const candidates = cancellation ? [persistence, cancellation] : [persistence];
				if (options.timeoutMs === undefined) await Promise.race(candidates);
				else {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							...candidates,
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new ToolPolicyError("POLICY_TIMEOUT", "Tool policy persistence timed out.")),
									options.timeoutMs,
								);
							}),
						]);
					} finally {
						if (timer) clearTimeout(timer);
					}
				}
			}
			mode = nextMode;
			revision++;
			return snapshot();
		});
		changeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};
	const policy: ToolPolicyCapability = {
		authorize,
		snapshot,
		setMode,
		dispose: () => {
			disposed = true;
		},
	};
	return policy;
}

export interface ToolApprovalCapability {
	request(toolName: string, parameters: unknown, signal?: AbortSignal): void | Promise<void>;
	/** Optional shared interaction facade used by hosts that expose structured UI channels. */
	readonly interaction?: {
		request(
			input: {
				readonly kind: "approval";
				readonly prompt: string;
				readonly toolCallId?: string;
				readonly intent?: "tool-approval";
			},
			signal?: AbortSignal,
		): Promise<{ readonly status: string; readonly approved?: boolean; readonly feedback?: string }>;
	};
}

export interface ToolOutputCapability {
	present<TResult extends AgentToolResult>(result: TResult): TResult;
}

export interface ToolCapabilitySnapshot {
	readonly workspace: WorkspaceCapability;
	readonly process: ProcessCapability;
	readonly network: NetworkCapability;
	readonly policy: ToolPolicyCapability;
	readonly approval: ToolApprovalCapability;
	readonly output: ToolOutputCapability;
	readonly skills?: SkillCatalog;
	readonly imageGeneration?: ImageGenerationCapability;
}

export type RuntimeAgentTool = AgentTool<TSchema, AgentToolResult>;

export type ToolFactory = (capabilities: ToolCapabilitySnapshot) => RuntimeAgentTool | undefined;

export function createDefaultToolCapabilities(allowedRoot: string, skills?: SkillCatalog): ToolCapabilitySnapshot {
	return {
		workspace: { allowedRoot },
		process: {},
		network: { available: false },
		policy: { authorize: () => undefined },
		approval: { request: () => undefined },
		output: { present: (result) => result },
		...(skills === undefined ? {} : { skills }),
	};
}
