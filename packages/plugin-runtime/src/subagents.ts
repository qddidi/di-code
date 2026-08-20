import type { Model } from "@di-code/ai";

/** A bounded, host-owned request for one child Agent run. */
export interface SubagentStartRequest {
	readonly parentSessionId: string;
	readonly cwd: string;
	readonly model: Pick<Model, "id" | "provider">;
	readonly prompt: string;
	readonly toolNames: readonly string[];
	readonly pluginIds: readonly string[];
	readonly depth: number;
	readonly maxDepth: number;
	readonly timeoutMs: number;
	readonly maxResultBytes: number;
}

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentInput {
	readonly text: string;
}

export interface SubagentResult {
	readonly id: string;
	readonly status: Exclude<SubagentStatus, "running">;
	readonly text: string;
	readonly errorMessage?: string;
}

export interface SubagentRun {
	readonly id: string;
	readonly parentSessionId: string;
	readonly providerId: string;
	readonly status: SubagentStatus;
	wait(signal?: AbortSignal): Promise<SubagentResult>;
	sendMessage(input: SubagentInput, signal?: AbortSignal): Promise<void>;
	cancel(): Promise<void>;
}

export interface SubagentProvider {
	readonly id: string;
	start(request: SubagentStartRequest, signal?: AbortSignal): Promise<SubagentRun>;
}
