import { spawn } from "node:child_process";
import type {
	DiagnosticsService,
	ExtensionContext,
	ExtensionErrorCode,
	ExtensionId,
	FileService,
	JobStartInput,
	JobsService,
	JsonValue,
	NetworkService,
	OperationOptions,
	ProviderEvent,
	ProviderRegistration,
	ProvidersService,
	SessionId,
	SessionService,
	SessionsService,
	SettingsService,
	SubagentRun,
	SubagentService,
	SubagentStartInput,
	SubprocessService,
	TaskEvent,
	TaskId,
	TaskReconcileInput,
	TaskReconcileResult,
	TaskResult,
	TaskSnapshot,
	TaskState,
	UiCustomInput,
	UiCustomResult,
	UiService,
} from "./freedom-stage0-contracts.ts";

export class ExtensionRuntimeError extends Error {
	readonly code: ExtensionErrorCode;
	readonly retryable: boolean;
	constructor(code: ExtensionErrorCode, message: string, retryable = false) {
		super(message);
		this.name = "ExtensionRuntimeError";
		this.code = code;
		this.retryable = retryable;
	}
}

export interface TaskRecord {
	readonly type: "task_created" | "task_state" | "task_event" | "task_terminal";
	readonly taskId: TaskId;
	readonly sequence: number;
	readonly state?: TaskState;
	readonly event?: TaskEvent;
	readonly result?: TaskResult;
	readonly idempotencyKey?: string;
}

export interface TaskStore {
	append(record: TaskRecord): Promise<void>;
	read(taskId: TaskId): Promise<readonly TaskRecord[]>;
}

export interface ExtensionRuntimeOptions {
	readonly extensionId: ExtensionId;
	readonly signal?: AbortSignal;
	readonly session?: SessionService;
	readonly files?: FileService;
	readonly subprocess?: SubprocessService;
	readonly network?: NetworkService;
	readonly settings?: SettingsService;
	readonly diagnostics?: DiagnosticsService;
	readonly sessions?: SessionsService;
	readonly providers?: ProvidersService;
	readonly jobs?: JobsService;
	readonly ui?: UiService;
	readonly subagents?: SubagentService;
	readonly taskStore?: TaskStore;
	readonly runSubagent?: (
		input: SubagentStartInput,
		signal: AbortSignal,
		emit: (event: Omit<TaskEvent, "version" | "taskId" | "sequence">) => Promise<void>,
	) => Promise<TaskResult>;
}

export interface ExtensionHostLifecycle {
	readonly signal: AbortSignal;
	dispose(): Promise<void>;
}

export interface ExtensionHostServices {
	readonly providers: ProvidersService;
	readonly subprocess: SubprocessService;
	readonly jobs: JobsService;
	readonly lifecycle: ExtensionHostLifecycle;
}

function createManagedSubprocessService(): SubprocessService {
	return {
		run: (input, options = {}) =>
			new Promise((resolve, reject) => {
				const limit = Math.max(1, input.maxOutputBytes ?? 256 * 1024);
				const child = spawn(input.command, [...input.args], {
					cwd: input.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				let truncated = false;
				const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
					const used = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
					const remaining = limit - used;
					if (remaining <= 0) {
						truncated = true;
						return;
					}
					const text = chunk.toString("utf8");
					const value = text.slice(0, remaining);
					if (value.length < text.length) truncated = true;
					if (target === "stdout") stdout += value;
					else stderr += value;
				};
				child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
				child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
				let timer: ReturnType<typeof setTimeout> | undefined;
				const abort = (): void => {
					child.kill();
					reject(new ExtensionRuntimeError("CANCELLED", "Subprocess cancelled", true));
				};
				if (options.signal) {
					if (options.signal.aborted) return abort();
					options.signal.addEventListener("abort", abort, { once: true });
				}
				if (options.timeoutMs !== undefined)
					timer = setTimeout(() => {
						child.kill();
						reject(new ExtensionRuntimeError("TIMEOUT", "Subprocess timed out", true));
					}, options.timeoutMs);
				child.once("error", (error) => reject(new ExtensionRuntimeError("FAILED", error.message)));
				child.once("close", (exitCode) => {
					if (timer) clearTimeout(timer);
					if (options.signal) options.signal.removeEventListener("abort", abort);
					resolve({ version: 1, exitCode: exitCode ?? -1, stdout, stderr, truncated });
				});
			}),
	};
}

interface ManagedJob {
	readonly controller: AbortController;
	state: "queued" | "running" | "completed" | "failed" | "cancelled";
	readonly result: Promise<JsonValue>;
}

/** Hosts provider, process, and background work under one bounded teardown owner. */
export function createExtensionHostServices(
	options: {
		readonly providers?: readonly ProviderRegistration[];
		readonly subprocess?: SubprocessService;
		readonly runJob?: (input: JobStartInput, options: OperationOptions) => Promise<JsonValue>;
		readonly signal?: AbortSignal;
	} = {},
): ExtensionHostServices {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const providers = new Map(options.providers?.map((provider) => [provider.id, provider]) ?? []);
	const jobs = new Map<string, ManagedJob>();
	let nextJob = 0;
	let disposed = false;
	const ensureOpen = (): void => {
		if (disposed) throw new ExtensionRuntimeError("DISPOSED", "Extension host is disposed");
	};
	const providerService: ProvidersService = {
		list: async () => [...providers.values()].map(({ id, models }) => ({ id, models })),
		get: async (id) => {
			const provider = providers.get(id);
			if (!provider) throw new ExtensionRuntimeError("PROVIDER_UNAVAILABLE", `Provider ${id} is unavailable`);
			return { id: provider.id, models: provider.models };
		},
		request: async function* (providerId, input, operation = {}): AsyncIterable<ProviderEvent> {
			ensureOpen();
			const provider = providers.get(providerId);
			if (!provider) throw new ExtensionRuntimeError("PROVIDER_UNAVAILABLE", `Provider ${providerId} is unavailable`);
			const requestSignal = operation.signal ? AbortSignal.any([signal, operation.signal]) : signal;
			for await (const event of provider.request(input, { ...operation, signal: requestSignal })) yield event;
		},
	};
	const subprocess: SubprocessService = options.subprocess ?? createManagedSubprocessService();
	const jobService: JobsService = {
		start: async (input, operation = {}) => {
			ensureOpen();
			if (!input.kind.trim()) throw new ExtensionRuntimeError("INVALID_INPUT", "Job kind is required");
			const jobId = `job-${++nextJob}`;
			const jobController = new AbortController();
			const jobSignal = operation.signal
				? AbortSignal.any([signal, operation.signal, jobController.signal])
				: AbortSignal.any([signal, jobController.signal]);
			const job: ManagedJob = {
				controller: jobController,
				state: "queued",
				result: Promise.resolve().then(async () => {
					job.state = "running";
					try {
						const value = await (options.runJob?.(input, { ...operation, signal: jobSignal }) ?? Promise.resolve(null));
						job.state = jobSignal.aborted ? "cancelled" : "completed";
						return value;
					} catch (error) {
						job.state = jobSignal.aborted ? "cancelled" : "failed";
						throw error;
					}
				}),
			};
			jobs.set(jobId, job);
			return {
				version: 1,
				jobId,
				get state() {
					return job.state;
				},
				result: job.result,
				cancel: async () => {
					jobController.abort();
					await job.result.catch(() => undefined);
				},
			};
		},
		get: async (jobId) => {
			const job = jobs.get(jobId);
			if (!job) throw new ExtensionRuntimeError("JOB_UNAVAILABLE", `Job ${jobId} is unavailable`);
			return { version: 1, jobId, state: job.state };
		},
		cancel: async (jobId) => {
			const job = jobs.get(jobId);
			if (!job) throw new ExtensionRuntimeError("JOB_UNAVAILABLE", `Job ${jobId} is unavailable`);
			job.controller.abort();
			await job.result.catch(() => undefined);
		},
	};
	return {
		providers: providerService,
		subprocess,
		jobs: jobService,
		lifecycle: {
			signal,
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				controller.abort();
				for (const job of jobs.values()) job.controller.abort();
				await Promise.allSettled([...jobs.values()].map((job) => job.result));
			},
		},
	};
}

function unavailable(code: ExtensionErrorCode, name: string): never {
	throw new ExtensionRuntimeError(code, `${name} is unavailable`);
}

const emptySession = (): SessionService => ({
	id: "" as SessionId,
	snapshot: async () => unavailable("SESSION_UNAVAILABLE", "Session"),
	append: async () => unavailable("SESSION_UNAVAILABLE", "Session"),
});

class MemoryTaskStore implements TaskStore {
	private readonly records = new Map<TaskId, TaskRecord[]>();
	async append(record: TaskRecord): Promise<void> {
		const list = this.records.get(record.taskId) ?? [];
		if (!list.some((item) => item.sequence === record.sequence)) list.push(record);
		this.records.set(record.taskId, list);
	}
	async read(taskId: TaskId): Promise<readonly TaskRecord[]> {
		return [...(this.records.get(taskId) ?? [])];
	}
}

function taskId(): TaskId {
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` as TaskId;
}

interface InternalTask {
	id: TaskId;
	label: string;
	sessionId?: SessionId;
	state: TaskState;
	sequence: number;
	result?: TaskResult;
	terminalWritten: boolean;
	followups: string[];
	processing: boolean;
	queue: TaskEvent[];
	waiters: ((event: TaskEvent | undefined) => void)[];
	eventDone: boolean;
	idempotency?: string;
	continuable: boolean;
	reconcile: Map<string, TaskReconcileResult>;
	reconcileInputs: Map<string, string>;
	lock: Promise<void>;
}

function snapshot(task: InternalTask): TaskSnapshot {
	return {
		version: 1,
		taskId: task.id,
		state: task.state,
		sequence: task.sequence,
		label: task.label,
		...(task.sessionId ? { sessionId: task.sessionId } : {}),
	};
}

export class InMemorySubagentService implements SubagentService {
	private readonly tasks = new Map<TaskId, InternalTask>();
	private readonly store: TaskStore;
	private readonly runSubagent?: ExtensionRuntimeOptions["runSubagent"];
	constructor(options: Pick<ExtensionRuntimeOptions, "taskStore" | "runSubagent"> = {}) {
		this.store = options.taskStore ?? new MemoryTaskStore();
		this.runSubagent = options.runSubagent;
	}
	private async persist(task: InternalTask, record: Omit<TaskRecord, "taskId" | "sequence">): Promise<void> {
		task.sequence += 1;
		await this.store.append({ ...record, taskId: task.id, sequence: task.sequence });
	}
	private push(task: InternalTask, event: Omit<TaskEvent, "version" | "taskId" | "sequence">): void {
		const value: TaskEvent = { version: 1, taskId: task.id, sequence: task.sequence + 1, ...event };
		task.sequence = value.sequence;
		task.queue.push(value);
		for (const waiter of task.waiters.splice(0)) waiter(value);
		void this.store.append({ type: "task_event", taskId: task.id, sequence: value.sequence, event: value });
	}
	private async transition(task: InternalTask, state: TaskState): Promise<void> {
		if (task.state === state) return;
		task.state = state;
		if (["completed", "failed", "cancelled", "timed_out"].includes(state)) task.terminalWritten = true;
		await this.persist(task, {
			type:
				state === "completed" || state === "failed" || state === "cancelled" || state === "timed_out"
					? "task_terminal"
					: "task_state",
			state,
			...(task.result ? { result: task.result } : {}),
		});
	}
	private async execute(task: InternalTask, input: SubagentStartInput, controller: AbortController): Promise<void> {
		try {
			if (this.runSubagent) {
				const result = await this.runSubagent(input, controller.signal, async (event) => {
					if (task.state === "starting") await this.transition(task, "running");
					if (event.type === "waiting") await this.transition(task, "waiting");
					this.push(task, event);
				});
				task.result = { ...result, taskId: task.id };
			} else {
				await this.transition(task, "running");
				task.result = { version: 1, taskId: task.id, text: input.prompt };
			}
			await this.transition(task, "completed");
		} catch (error) {
			if (controller.signal.aborted) {
				await this.transition(task, "cancelled");
				task.result = { version: 1, taskId: task.id, text: "" };
			} else {
				task.state = task.state === "starting" ? "needs_reconciliation" : "failed";
				await this.persist(task, {
					type: task.state === "needs_reconciliation" ? "task_state" : "task_terminal",
					state: task.state,
				});
				if (task.state === "failed")
					task.result = { version: 1, taskId: task.id, text: error instanceof Error ? error.message : "Task failed" };
			}
		} finally {
			task.processing = false;
			if (task.followups.length > 0 && task.state === "completed") {
				task.state = "waiting";
				const next = task.followups.shift();
				if (next)
					void this.execute(
						task,
						{ prompt: next, label: task.label, sessionId: task.sessionId, mode: "continuable" },
						controller,
					);
			}
			if (["completed", "failed", "cancelled", "timed_out"].includes(task.state)) {
				task.eventDone = true;
				for (const waiter of task.waiters.splice(0)) waiter(undefined);
			}
		}
	}
	async start(input: SubagentStartInput, options: OperationOptions = {}): Promise<SubagentRun> {
		if (!input.prompt.trim() || !input.label.trim())
			throw new ExtensionRuntimeError("INVALID_INPUT", "prompt and label are required");
		const id = taskId();
		const task: InternalTask = {
			id,
			label: input.label,
			sessionId: input.sessionId,
			state: "starting",
			sequence: 0,
			terminalWritten: false,
			followups: [],
			processing: true,
			queue: [],
			waiters: [],
			eventDone: false,
			idempotency: input.idempotencyKey,
			continuable: input.mode === "continuable",
			reconcile: new Map(),
			reconcileInputs: new Map(),
			lock: Promise.resolve(),
		};
		this.tasks.set(id, task);
		await this.persist(task, { type: "task_created", state: "starting", idempotencyKey: input.idempotencyKey });
		const controller = new AbortController();
		if (options.signal)
			options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
		const runPromise = this.execute(task, input, controller);
		const events = (async function* (_self: InMemorySubagentService): AsyncIterable<TaskEvent> {
			while (!task.eventDone || task.queue.length) {
				if (task.queue.length) yield task.queue.shift() as TaskEvent;
				else {
					const event = await new Promise<TaskEvent | undefined>((resolve) => task.waiters.push(resolve));
					if (event) yield event;
				}
			}
		})(this);
		return {
			taskId: id,
			get state() {
				return task.state;
			},
			result: runPromise.then(() => task.result ?? { version: 1, taskId: id, text: "" }),
			events,
			followup: async (prompt, _followOptions = {}) => {
				if (!task.continuable || (task.state !== "completed" && task.state !== "waiting" && task.state !== "running"))
					throw new ExtensionRuntimeError("CONFLICT", "Task is not continuable");
				task.followups.push(prompt);
				return snapshot(task);
			},
			cancel: async () => {
				controller.abort();
				await runPromise;
				return snapshot(task);
			},
		};
	}
	async get(id: TaskId): Promise<TaskSnapshot> {
		const task = this.tasks.get(id);
		if (!task) throw new ExtensionRuntimeError("NOT_FOUND", `Task ${id} not found`);
		return snapshot(task);
	}
	async reconcileTask(input: TaskReconcileInput): Promise<TaskReconcileResult> {
		const task = this.tasks.get(input.taskId);
		if (!task) throw new ExtensionRuntimeError("NOT_FOUND", "Task not found");
		const fingerprint = JSON.stringify(input.decision);
		const previous = task.reconcile.get(input.idempotencyKey);
		if (previous) {
			if (task.reconcileInputs.get(input.idempotencyKey) !== fingerprint)
				throw new ExtensionRuntimeError("INVALID_INPUT", "idempotencyKey was already used with different parameters");
			return previous;
		}
		if (task.state !== "needs_reconciliation")
			throw new ExtensionRuntimeError("CONFLICT", "Task does not need reconciliation");
		if (input.decision.type === "resume" && !input.decision.confirmedStopped)
			throw new ExtensionRuntimeError("INVALID_INPUT", "resume requires confirmedStopped");
		if (input.decision.type === "resume") await this.transition(task, "waiting");
		else if (input.decision.type === "complete") {
			if (!task.terminalWritten) {
				task.result = input.decision.result;
				task.terminalWritten = true;
				await this.transition(task, "completed");
			}
		} else {
			if (!task.terminalWritten) {
				task.terminalWritten = true;
				await this.transition(task, "cancelled");
			}
		}
		const result = {
			version: 1 as const,
			taskId: task.id,
			state: task.state,
			sequence: task.sequence,
			idempotencyKey: input.idempotencyKey,
		};
		task.reconcileInputs.set(input.idempotencyKey, fingerprint);
		task.reconcile.set(input.idempotencyKey, result);
		return result;
	}
}

export function createExtensionContext(options: ExtensionRuntimeOptions): ExtensionContext {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const host = createExtensionHostServices({ signal });
	const subagents = options.subagents ?? new InMemorySubagentService(options);
	const ui = options.ui ?? {
		custom: async (_input: UiCustomInput): Promise<UiCustomResult> => unavailable("UI_UNAVAILABLE", "UI"),
		notify: async () => unavailable("UI_UNAVAILABLE", "UI"),
	};
	return Object.freeze({
		apiVersion: 1 as const,
		extensionId: options.extensionId,
		signal,
		session: options.session ?? emptySession(),
		files: options.files ?? {
			read: async () => unavailable("SESSION_UNAVAILABLE", "Files"),
			write: async () => unavailable("SESSION_UNAVAILABLE", "Files"),
		},
		subprocess: options.subprocess ?? host.subprocess,
		network: options.network ?? { fetch: async () => unavailable("NETWORK_UNAVAILABLE", "Network") },
		subagents,
		ui,
		settings: options.settings ?? { get: async () => unavailable("FAILED", "Settings") },
		diagnostics: options.diagnostics ?? { report: () => undefined },
		sessions: options.sessions ?? {
			get: async () => unavailable("SESSION_UNAVAILABLE", "Sessions"),
			list: async () => [],
		},
		providers: options.providers ?? host.providers,
		jobs: options.jobs ?? host.jobs,
	});
}
