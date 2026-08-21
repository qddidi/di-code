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
// Keep recent terminal results available to the wait tool after active runs are reclaimed.
const TERMINAL_RESULT_CACHE_SIZE = 128;

function errorMessage(cause: unknown): string {
	return redactCredentials(cause instanceof Error ? cause.message : String(cause)).slice(0, 1_000);
}

function boundedText(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	const marker = Buffer.from("\n[truncated]", "utf8");
	if (maxBytes <= marker.byteLength) {
		for (let end = Math.min(maxBytes, bytes.byteLength); end >= 0; end--) {
			const prefix = bytes.subarray(0, end).toString("utf8");
			if (Buffer.byteLength(prefix, "utf8") <= maxBytes) return prefix;
		}
		return "";
	}
	for (let end = Math.min(maxBytes - marker.byteLength, bytes.byteLength); end >= 0; end--) {
		const prefix = bytes.subarray(0, end).toString("utf8");
		if (Buffer.byteLength(prefix, "utf8") + marker.byteLength <= maxBytes) return `${prefix}\n[truncated]`;
	}
	return "\n[truncated]";
}

function redactCredentials(value: string): string {
	return value
		.replace(
			/(\b(?:api[_-]?key|token|secret|authorization|password)\b\s*[=:]\s*(?:Bearer\s+)?)[^\s,;}\]]+/gi,
			"$1[redacted]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error(message));
	return new Promise<T>((resolve, reject) => {
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const onAbort = (): void => {
			cleanup();
			reject(new Error(message));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(cause) => {
				cleanup();
				reject(cause);
			},
		);
	});
}

function isTerminalStatus(status: SubagentStatus): status is Exclude<SubagentStatus, "running"> {
	return status === "completed" || status === "failed" || status === "cancelled";
}

class InProcessRun implements SubagentRun {
	private _status: SubagentStatus = "running";
	private readonly abortController = new AbortController();
	private readonly session: AgentSession;
	private readonly resultPromise: Promise<SubagentResult>;
	private resolveResult!: (result: SubagentResult) => void;
	readonly id: string;
	readonly parentSessionId: string;
	readonly providerId = "in-process";

	constructor(id: string, request: SubagentStartRequest, session: AgentSession, maxResultBytes: number) {
		this.id = id;
		this.parentSessionId = request.parentSessionId;
		this.sessionPrompt = request.prompt;
		this.maxResultBytes = maxResultBytes;
		this.session = session;
		this.resultPromise = new Promise<SubagentResult>((resolve) => {
			this.resolveResult = resolve;
		});
	}

	begin(): void {
		void this.run(this.sessionPrompt, this.maxResultBytes);
	}

	private readonly sessionPrompt: string;
	private readonly maxResultBytes: number;

	get status(): SubagentStatus {
		return this._status;
	}

	wait(signal?: AbortSignal): Promise<SubagentResult> {
		return waitWithSignal(this.resultPromise, signal, "Subagent wait was cancelled.");
	}

	async sendMessage(input: SubagentInput, signal?: AbortSignal): Promise<void> {
		if (this._status !== "running") throw new Error(`Subagent "${this.id}" is ${this._status}.`);
		if (!input.text.trim()) throw new Error("send_message.message must be non-empty");
		if (signal?.aborted) throw new Error("Subagent message was cancelled.");
		await this.session.steer(input.text, signal);
	}

	async cancel(): Promise<void> {
		if (this._status !== "running") return;
		this.abortController.abort();
		this._status = "cancelled";
		this.resolveResult({ id: this.id, status: "cancelled", text: "" });
	}

	private async run(prompt: string, maxResultBytes: number): Promise<void> {
		try {
			const result = await this.session.prompt(prompt, this.abortController.signal);
			if (this._status !== "running") return;
			this._status =
				result.stopReason === "aborted" ? "cancelled" : result.stopReason === "error" ? "failed" : "completed";
			const text = redactCredentials(
				result.content
					.filter((content) => content.type === "text")
					.map((content) => content.text)
					.join(""),
			);
			const final: SubagentResult = {
				id: this.id,
				status: this._status,
				text: boundedText(text, maxResultBytes),
				...(result.errorMessage ? { errorMessage: errorMessage(result.errorMessage) } : {}),
			};
			this.resolveResult(final);
		} catch (cause) {
			if (this._status !== "running") return;
			this._status = this.abortController.signal.aborted ? "cancelled" : "failed";
			const final: SubagentResult = { id: this.id, status: this._status, text: "", errorMessage: errorMessage(cause) };
			this.resolveResult(final);
		}
	}
}

/** Normalizes plugin provider lifecycle so a provider cannot leave the host waiting forever. */
class ManagedRun implements SubagentRun {
	private _status: SubagentStatus = "running";
	private readonly resultPromise: Promise<SubagentResult>;
	private resolveResult!: (result: SubagentResult) => void;
	private readonly timeout: ReturnType<typeof setTimeout>;
	readonly id: string;
	readonly parentSessionId: string;
	readonly providerId: string;
	private readonly inner: SubagentRun;

	constructor(inner: SubagentRun, timeoutMs: number, maxResultBytes: number) {
		this.inner = inner;
		this.id = inner.id;
		this.parentSessionId = inner.parentSessionId;
		this.providerId = inner.providerId;
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		this.timeout = setTimeout(() => void this.finishCancelled(), timeoutMs);
		void this.observe(maxResultBytes);
	}

	get status(): SubagentStatus {
		return this._status;
	}

	wait(signal?: AbortSignal): Promise<SubagentResult> {
		return waitWithSignal(this.resultPromise, signal, "Subagent wait was cancelled.");
	}

	sendMessage(input: SubagentInput, signal?: AbortSignal): Promise<void> {
		if (!input.text.trim()) return Promise.reject(new Error("send_message.message must be non-empty"));
		if (signal?.aborted) return Promise.reject(new Error("Subagent message was cancelled."));
		return this.inner.sendMessage(input, signal);
	}

	async cancel(): Promise<void> {
		if (this._status !== "running") return;
		await this.finishCancelled();
	}

	private async observe(maxResultBytes: number): Promise<void> {
		try {
			const result = await this.inner.wait();
			if (this._status !== "running") return;
			if (
				result.id !== this.id ||
				!isTerminalStatus(result.status) ||
				typeof result.text !== "string" ||
				(result.errorMessage !== undefined && typeof result.errorMessage !== "string")
			)
				throw new Error("Subagent provider returned an invalid result.");
			this._status = result.status;
			this.resolveResult({
				...result,
				text: boundedText(redactCredentials(result.text), maxResultBytes),
				...(result.errorMessage === undefined ? {} : { errorMessage: errorMessage(result.errorMessage) }),
			});
		} catch (cause) {
			if (this._status !== "running") return;
			this._status = "failed";
			this.resolveResult({ id: this.id, status: "failed", text: "", errorMessage: errorMessage(cause) });
		} finally {
			clearTimeout(this.timeout);
		}
	}

	private async finishCancelled(): Promise<void> {
		if (this._status !== "running") return;
		this._status = "cancelled";
		this.resolveResult({ id: this.id, status: "cancelled", text: "" });
		clearTimeout(this.timeout);
		void this.inner.cancel().catch(() => undefined);
	}
}

export class SubagentService {
	private readonly config: SubagentServiceOptions;
	private readonly options: Required<
		Pick<SubagentServiceOptions, "maxDepth" | "maxConcurrent" | "defaultTimeoutMs" | "maxResultBytes">
	>;
	private readonly providers: ReadonlyMap<string, SubagentProvider>;
	private readonly runs = new Map<string, SubagentRun>();
	private readonly terminalResults = new Map<string, SubagentResult>();
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
		if (!Number.isInteger(this.options.defaultTimeoutMs) || this.options.defaultTimeoutMs < 1)
			throw new RangeError("defaultTimeoutMs must be positive");
		if (!Number.isInteger(this.options.maxResultBytes) || this.options.maxResultBytes < 1)
			throw new RangeError("maxResultBytes must be positive");
		const providerEntries = new Map<string, SubagentProvider>();
		for (const provider of options.providers ?? []) {
			if (!provider.id.trim()) throw new Error("subagent provider id must be non-empty");
			if (providerEntries.has(provider.id)) throw new Error(`Duplicate subagent provider "${provider.id}".`);
			providerEntries.set(provider.id, provider);
		}
		this.providers = providerEntries;
		this.config = options;
	}

	list(): readonly SubagentRun[] {
		return [...this.runs.values()];
	}

	private rememberTerminalResult(result: SubagentResult): void {
		this.terminalResults.delete(result.id);
		this.terminalResults.set(result.id, result);
		if (this.terminalResults.size <= TERMINAL_RESULT_CACHE_SIZE) return;
		const oldestId = this.terminalResults.keys().next().value;
		if (oldestId !== undefined) this.terminalResults.delete(oldestId);
	}

	private completeRun(run: SubagentRun, result: SubagentResult): void {
		if (this.runs.get(run.id) !== run) return;
		this.runs.delete(run.id);
		this.activeCount--;
		this.rememberTerminalResult(result);
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
		let inProcess: InProcessRun | undefined;
		try {
			if (custom) {
				const providerRun = await custom.start(request, signal);
				if (
					!providerRun ||
					typeof providerRun.id !== "string" ||
					!providerRun.id.trim() ||
					typeof providerRun.providerId !== "string" ||
					providerRun.providerId !== custom.id ||
					typeof providerRun.parentSessionId !== "string" ||
					providerRun.parentSessionId !== request.parentSessionId ||
					providerRun.status !== "running" ||
					typeof providerRun.wait !== "function" ||
					typeof providerRun.cancel !== "function" ||
					typeof providerRun.sendMessage !== "function"
				) {
					if (providerRun && typeof providerRun.cancel === "function")
						await providerRun.cancel().catch(() => undefined);
					throw new Error(`Subagent provider "${custom.id}" returned an invalid running instance.`);
				}
				run = new ManagedRun(providerRun, this.options.defaultTimeoutMs, this.options.maxResultBytes);
			} else {
				inProcess = new InProcessRun(id, request, this.config.createSession(request), this.options.maxResultBytes);
				run = inProcess;
			}
		} catch (cause) {
			this.activeCount--;
			throw cause;
		}
		if (
			!run ||
			typeof run.id !== "string" ||
			typeof run.providerId !== "string" ||
			typeof run.parentSessionId !== "string" ||
			typeof run.wait !== "function" ||
			typeof run.cancel !== "function" ||
			typeof run.sendMessage !== "function"
		) {
			this.activeCount--;
			throw new Error("Subagent provider returned an invalid run.");
		}
		if (run.parentSessionId !== request.parentSessionId) {
			this.activeCount--;
			await run.cancel();
			throw new Error(`Subagent provider "${run.providerId}" returned a run for a different parent Session.`);
		}
		if (!run.id.trim() || !run.providerId.trim()) {
			this.activeCount--;
			await run.cancel();
			throw new Error(`Subagent provider "${run.providerId}" returned invalid run identifiers.`);
		}
		if (signal?.aborted) {
			this.activeCount--;
			await run.cancel();
			throw new Error("Subagent start was cancelled.");
		}
		if (this.runs.has(run.id)) {
			this.activeCount--;
			await run.cancel();
			throw new Error(`Subagent run id "${run.id}" is already in use.`);
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
		this.terminalResults.delete(run.id);
		inProcess?.begin();
		const abortListener = signal ? () => void run.cancel() : undefined;
		if (signal && abortListener) signal.addEventListener("abort", abortListener, { once: true });
		const timeout = setTimeout(() => void run.cancel(), this.options.defaultTimeoutMs);
		void run
			.wait()
			.then(
				(result) => {
					this.completeRun(run, result);
					return this.config.emit?.({
						type: "subagent_end",
						runId: run.id,
						parentSessionId: request.parentSessionId,
						status: result.status,
						text: result.text,
						...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
					});
				},
				() => {
					if (this.runs.get(run.id) === run) {
						this.runs.delete(run.id);
						this.activeCount--;
					}
				},
			)
			.catch(() => undefined)
			.finally(() => {
				clearTimeout(timeout);
				if (signal && abortListener) signal.removeEventListener("abort", abortListener);
			});
		return run;
	}

	get(id: string): SubagentRun {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown subagent "${id}".`);
		return run;
	}

	async interrupt(id: string): Promise<void> {
		const run = this.runs.get(id);
		if (run) {
			await run.cancel();
			return;
		}
		if (this.terminalResults.has(id)) return;
		throw new Error(`Unknown subagent "${id}".`);
	}

	async dispose(): Promise<void> {
		const runs = [...this.runs.values()];
		await Promise.all(runs.map((run) => run.cancel()));
		await Promise.all(runs.map((run) => run.wait().catch(() => undefined)));
		this.terminalResults.clear();
	}

	createTools(): readonly AgentTool<TSchema, AgentToolResult>[] {
		const text = (value: string): AgentToolResult => [{ type: "text", text: value }];
		return [
			{
				name: "subagent",
				description: "Start a bounded child Agent and return its run id.",
				parameters: {
					type: "object",
					required: ["prompt"],
					properties: {
						prompt: { type: "string" },
						depth: { type: "integer" },
						providerId: { type: "string" },
					},
					additionalProperties: false,
				},
				execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
					const value = args as { prompt?: unknown; depth?: unknown; providerId?: unknown };
					if (typeof value.prompt !== "string") throw new Error("subagent.prompt must be a string");
					if (value.depth !== undefined && (!Number.isInteger(value.depth) || typeof value.depth !== "number"))
						throw new Error("subagent.depth must be an integer");
					if (value.providerId !== undefined && typeof value.providerId !== "string")
						throw new Error("subagent.providerId must be a string");
					const run = await this.start(
						{
							prompt: value.prompt,
							depth: value.depth as number | undefined,
							providerId: value.providerId as string | undefined,
						},
						signal,
					);
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
					const value = args as { id?: unknown; message?: unknown };
					if (typeof value.id !== "string" || value.id.trim() === "")
						throw new Error("send_message.id must be non-empty");
					if (typeof value.message !== "string") throw new Error("send_message.message must be a string");
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
					const id = (args as { id?: unknown }).id;
					if (typeof id !== "string" || id.trim() === "") throw new Error("wait.id must be non-empty");
					const activeRun = this.runs.get(id);
					const result = activeRun ? await activeRun.wait(signal) : this.terminalResults.get(id);
					if (!result) throw new Error(`Unknown subagent "${id}".`);
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
					const id = (args as { id?: unknown }).id;
					if (typeof id !== "string" || id.trim() === "") throw new Error("interrupt.id must be non-empty");
					await this.interrupt(id);
					return text("Interrupt requested.");
				},
			},
		] as unknown as readonly AgentTool<TSchema, AgentToolResult>[];
	}
}
