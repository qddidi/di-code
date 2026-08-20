import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@di-code/agent";
import type { Model, Provider, TSchema } from "@di-code/ai";
import type {
	SubagentInput,
	SubagentProvider,
	SubagentResult,
	SubagentRun,
	SubagentStartRequest,
	SubagentStatus,
} from "@di-code/plugin-runtime";
import type { AgentSession } from "../core/session.ts";

export interface SubagentEvent {
	readonly type: "subagent_start" | "subagent_update" | "subagent_end";
	readonly runId: string;
	readonly parentSessionId: string;
	readonly status: SubagentStatus;
	readonly text?: string;
	readonly errorMessage?: string;
}

export interface SubagentServiceOptions {
	readonly parentSessionId: string;
	readonly cwd: string;
	readonly provider: Provider;
	readonly model: Model;
	readonly createSession: (request: SubagentStartRequest) => AgentSession;
	readonly providers?: readonly SubagentProvider[];
	readonly maxDepth?: number;
	readonly maxConcurrent?: number;
	readonly defaultTimeoutMs?: number;
	readonly maxResultBytes?: number;
	readonly currentDepth?: number;
	readonly toolNames?: readonly string[];
	readonly pluginIds?: readonly string[];
	readonly emit?: (event: SubagentEvent) => void | Promise<void>;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;

function errorMessage(cause: unknown): string {
	return (cause instanceof Error ? cause.message : String(cause))
		.replace(/(api[_-]?key|token|secret|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
		.slice(0, 1_000);
}

function boundedText(value: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= maxBytes) return value;
	let output = value;
	while (Buffer.byteLength(output, "utf8") > Math.max(0, maxBytes - 32)) output = output.slice(0, -1);
	return `${output}\n[truncated]`;
}

class InProcessRun implements SubagentRun {
	private _status: SubagentStatus = "running";
	private readonly abortController = new AbortController();
	private readonly timeout: ReturnType<typeof setTimeout>;
	private readonly session: AgentSession;
	private readonly resultPromise: Promise<SubagentResult>;
	private resolveResult!: (result: SubagentResult) => void;
	readonly id: string;
	readonly parentSessionId: string;
	readonly providerId = "in-process";

	constructor(
		id: string,
		request: SubagentStartRequest,
		session: AgentSession,
		emit: (event: SubagentEvent) => void | Promise<void>,
		maxResultBytes: number,
	) {
		this.id = id;
		this.parentSessionId = request.parentSessionId;
		this.session = session;
		this.resultPromise = new Promise<SubagentResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.timeout = setTimeout(() => this.abortController.abort(), request.timeoutMs);
		void this.run(request.prompt, emit, maxResultBytes);
	}

	get status(): SubagentStatus {
		return this._status;
	}

	wait(signal?: AbortSignal): Promise<SubagentResult> {
		if (!signal) return this.resultPromise;
		if (signal.aborted) return Promise.reject(new Error("Subagent wait was cancelled."));
		return Promise.race([
			this.resultPromise,
			new Promise<SubagentResult>((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("Subagent wait was cancelled.")), { once: true });
			}),
		]);
	}

	async sendMessage(input: SubagentInput, signal?: AbortSignal): Promise<void> {
		if (this._status !== "running") throw new Error(`Subagent "${this.id}" is ${this._status}.`);
		await this.session.steer(input.text, signal);
	}

	async cancel(): Promise<void> {
		if (this._status !== "running") return;
		this.abortController.abort();
	}

	private async run(
		prompt: string,
		emit: (event: SubagentEvent) => void | Promise<void>,
		maxResultBytes: number,
	): Promise<void> {
		try {
			const result = await this.session.prompt(prompt, this.abortController.signal);
			this._status =
				result.stopReason === "aborted" ? "cancelled" : result.stopReason === "error" ? "failed" : "completed";
			const text = boundedText(
				result.content
					.filter((content) => content.type === "text")
					.map((content) => content.text)
					.join(""),
				maxResultBytes,
			);
			const final: SubagentResult = {
				id: this.id,
				status: this._status,
				text,
				...(result.errorMessage ? { errorMessage: errorMessage(result.errorMessage) } : {}),
			};
			this.resolveResult(final);
			clearTimeout(this.timeout);
			await emit({
				type: "subagent_end",
				runId: this.id,
				parentSessionId: this.parentSessionId,
				status: final.status,
				text: final.text,
				...(final.errorMessage ? { errorMessage: final.errorMessage } : {}),
			});
		} catch (cause) {
			this._status = this.abortController.signal.aborted ? "cancelled" : "failed";
			const final: SubagentResult = { id: this.id, status: this._status, text: "", errorMessage: errorMessage(cause) };
			this.resolveResult(final);
			clearTimeout(this.timeout);
			await emit({
				type: "subagent_end",
				runId: this.id,
				parentSessionId: this.parentSessionId,
				status: final.status,
				errorMessage: final.errorMessage,
			});
		}
	}
}

export class SubagentService {
	private readonly config: SubagentServiceOptions;
	private readonly options: Required<
		Pick<SubagentServiceOptions, "maxDepth" | "maxConcurrent" | "defaultTimeoutMs" | "maxResultBytes">
	>;
	private readonly providers: ReadonlyMap<string, SubagentProvider>;
	private readonly runs = new Map<string, SubagentRun>();
	private activeCount = 0;

	constructor(options: SubagentServiceOptions) {
		if (!options.parentSessionId.trim()) throw new Error("parentSessionId must be non-empty");
		this.options = {
			maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
			maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
			defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
		};
		if (!Number.isInteger(this.options.maxDepth) || this.options.maxDepth < 0)
			throw new RangeError("maxDepth must be a non-negative integer");
		if (!Number.isInteger(this.options.maxConcurrent) || this.options.maxConcurrent < 1)
			throw new RangeError("maxConcurrent must be positive");
		this.providers = new Map([...(options.providers ?? []).map((provider) => [provider.id, provider] as const)]);
		this.config = options;
	}

	list(): readonly SubagentRun[] {
		return [...this.runs.values()];
	}

	async start(
		input: {
			readonly prompt: string;
			readonly depth?: number;
			readonly providerId?: string;
		},
		signal?: AbortSignal,
	): Promise<SubagentRun> {
		const depth = input.depth ?? (this.config.currentDepth ?? 0) + 1;
		if (!input.prompt.trim()) throw new Error("subagent.prompt must be non-empty");
		if (!Number.isInteger(depth) || depth < 0 || depth > this.options.maxDepth)
			throw new Error(`Subagent depth must be between 0 and ${this.options.maxDepth}.`);
		if (this.activeCount >= this.options.maxConcurrent) throw new Error("Subagent concurrency limit reached.");
		if (input.providerId !== undefined && !this.providers.has(input.providerId))
			throw new Error(`Unknown subagent provider "${input.providerId}".`);
		if (signal?.aborted) throw new Error("Subagent start was cancelled.");
		const id = randomUUID();
		const request: SubagentStartRequest = {
			parentSessionId: this.config.parentSessionId,
			cwd: this.config.cwd,
			model: { id: this.config.model.id, provider: this.config.model.provider },
			prompt: input.prompt,
			toolNames: [...(this.config.toolNames ?? [])],
			pluginIds: [...(this.config.pluginIds ?? [])],
			depth,
			maxDepth: this.options.maxDepth,
			timeoutMs: this.options.defaultTimeoutMs,
			maxResultBytes: this.options.maxResultBytes,
		};
		this.activeCount++;
		const custom = input.providerId ? this.providers.get(input.providerId) : undefined;
		let run: SubagentRun;
		try {
			run = custom
				? await custom.start(request, signal)
				: new InProcessRun(
						id,
						request,
						this.config.createSession(request),
						(event) => this.config.emit?.(event),
						this.options.maxResultBytes,
					);
		} catch (cause) {
			this.activeCount--;
			throw cause;
		}
		if (run.parentSessionId !== request.parentSessionId) {
			this.activeCount--;
			await run.cancel();
			throw new Error(`Subagent provider "${run.providerId}" returned a run for a different parent Session.`);
		}
		try {
			await this.config.emit?.({
				type: "subagent_start",
				runId: run.id,
				parentSessionId: request.parentSessionId,
				status: run.status,
			});
		} catch (cause) {
			this.activeCount--;
			await run.cancel();
			throw cause;
		}
		this.runs.set(run.id, run);
		const timeout = setTimeout(() => void run.cancel(), this.options.defaultTimeoutMs);
		void run
			.wait()
			.then(
				() => this.activeCount--,
				() => this.activeCount--,
			)
			.finally(() => clearTimeout(timeout));
		return run;
	}

	get(id: string): SubagentRun {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown subagent "${id}".`);
		return run;
	}

	async interrupt(id: string): Promise<void> {
		await this.get(id).cancel();
	}

	async dispose(): Promise<void> {
		const runs = [...this.runs.values()];
		await Promise.all(runs.map((run) => run.cancel()));
		await Promise.all(runs.map((run) => run.wait().catch(() => undefined)));
	}

	createTools(): readonly AgentTool<TSchema, AgentToolResult>[] {
		const text = (value: string): AgentToolResult => [{ type: "text", text: value }];
		return [
			{
				name: "subagent",
				description: "Start a bounded child Agent and return its run id.",
				parameters: {
					type: "object",
					properties: { prompt: { type: "string" }, depth: { type: "integer" } },
					required: ["prompt"],
					additionalProperties: false,
				},
				execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
					const value = args as { prompt: string; depth?: number };
					const run = await this.start(value, signal);
					return text(JSON.stringify({ id: run.id, status: run.status }));
				},
			},
			{
				name: "subagent_list",
				description: "List child Agent runs owned by this Session.",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async () => text(JSON.stringify(this.list().map((run) => ({ id: run.id, status: run.status })))),
			},
			{
				name: "send_message",
				description: "Send a message to a running child Agent.",
				parameters: {
					type: "object",
					properties: { id: { type: "string" }, message: { type: "string" } },
					required: ["id", "message"],
					additionalProperties: false,
				},
				execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
					const value = args as { id: string; message: string };
					await this.get(value.id).sendMessage({ text: value.message }, signal);
					return text("Message sent.");
				},
			},
			{
				name: "wait",
				description: "Wait for a child Agent and return its bounded result.",
				parameters: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
					additionalProperties: false,
				},
				execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
					const result = await this.get((args as { id: string }).id).wait(signal);
					return text(
						JSON.stringify({
							id: result.id,
							status: result.status,
							text: result.text,
							...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
						}),
					);
				},
			},
			{
				name: "interrupt",
				description: "Cancel a running child Agent.",
				parameters: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
					additionalProperties: false,
				},
				execute: async (_id: string, args: Record<string, unknown>) => {
					await this.interrupt((args as { id: string }).id);
					return text("Interrupt requested.");
				},
			},
		] as unknown as readonly AgentTool<TSchema, AgentToolResult>[];
	}
}
