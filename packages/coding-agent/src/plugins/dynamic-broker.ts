import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentContextProvider, AgentRequestContext, AgentTool, ToolExecutionMiddleware } from "@di-code/agent";
import { type ToolResultContent, Type } from "@di-code/ai";
import {
	type ActiveRunSnapshot,
	DYNAMIC_PLUGIN_MAX_LINE_BYTES,
	DYNAMIC_PLUGIN_PROTOCOL_VERSION,
	type DynamicPackageDefinition,
	type DynamicPackageSnapshot,
	type DynamicPluginChildInvocationRecord,
	type DynamicPluginContext as DynamicPluginContextWire,
	type DynamicPluginMiddlewareCapability,
	DynamicPluginRuntime,
	type DynamicPluginToolCapability,
	type Package,
	parseDynamicPluginCapabilityRecord,
	parseDynamicPluginChildInvocationRecord,
} from "@di-code/plugin-runtime";

export interface DynamicPluginApproval {
	readonly pluginId: string;
	readonly version: string;
	readonly capabilities: readonly string[];
	readonly sourceHash: string;
	readonly sourceBytes: number;
	readonly impact: "executes-session-code";
}

export interface DynamicPluginBrokerOptions {
	readonly cwd: string;
	readonly mode: "interactive" | "print" | "json";
	readonly model?: string;
	readonly projectTrusted?: boolean;
	readonly reservedToolNames?: readonly string[];
	readonly allowDynamicPlugins?: boolean;
	readonly confirmRun?: (approval: DynamicPluginApproval) => boolean | Promise<boolean>;
	readonly onDiagnostic?: (diagnostic: DynamicPluginDiagnostic) => void;
	readonly killGraceMs?: number;
}

export interface DynamicPluginDiagnostic {
	readonly pluginId?: string;
	readonly runId?: string;
	readonly stage: "approval" | "spawn" | "protocol" | "stderr" | "timeout" | "exit" | "cleanup";
	readonly message: string;
}

interface DynamicRun {
	readonly packageId: string;
	readonly pluginId: string;
	readonly runId: string;
	readonly child: ChildProcessWithoutNullStreams;
	readonly ready: Promise<void>;
	readonly rejectReady: (cause: unknown) => void;
	settled: boolean;
	readyConsumed: boolean;
	cleanupPromise?: Promise<void>;
	pending: Map<string, PendingInvocation>;
	nexts: Map<string, (execution: Record<string, unknown>) => Promise<unknown>>;
}

interface PendingInvocation {
	readonly resolve: (value: unknown) => void;
	readonly reject: (cause: unknown) => void;
	readonly signal?: AbortSignal;
}

let invocationSequence = 0;

interface ChildRecord {
	readonly kind: "ready" | "stopped" | "error";
	readonly message?: string;
}

export interface DynamicPluginContext extends DynamicPluginContextWire {
	readonly signal?: AbortSignal;
}

const BOOTSTRAP = String.raw`
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
let stopping = false;
let bootstrapped = false;
let sequence = 0;
let writes = Promise.resolve();
const handlers = new Map();
const active = new Map();
const pendingNext = new Map();
const write = (record) => {
  writes = writes.then(() => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(record) + "\n", (error) => error ? reject(error) : resolve())));
  return writes;
};
const disposable = (send) => {
  let disposed = false;
  return { dispose: () => { if (disposed) return; disposed = true; void send().catch(() => undefined); } };
};
const capability = (pluginId, runId, value, handler) => {
  const id = typeof value.id === "string" ? value.id : typeof value.name === "string" ? value.name : "capability-" + (++sequence);
  handlers.set(id, { type: value.type, handler });
  const record = { version: 1, id: "cap-" + (++sequence), method: "capability_register", params: { pluginId, runId, capability: { ...value, id } } };
  const registered = write(record);
  return { dispose: () => { handlers.delete(id); return registered.then(() => write({ version: 1, id: "cap-" + (++sequence), method: "capability_revoke", params: { pluginId, runId, capabilityId: id } })); } };
};
const createApi = (pluginId, runId) => ({
  registerTool: (tool) => capability(pluginId, runId, { type: "tool", name: tool.name, description: tool.description, parameters: tool.parameters, id: tool.name }, tool.execute),
  registerPromptSection: (section) => capability(pluginId, runId, { type: "prompt", id: section.id, order: section.order }, section.render),
  useToolMiddleware: (middleware) => capability(pluginId, runId, { type: "middleware", id: middleware.id }, middleware.execute),
  on: (event, handler) => capability(pluginId, runId, { type: "event", id: "event:" + event + ":" + (++sequence), event }, handler),
});
const contextFor = (record, controller) => ({ ...record.context, signal: controller.signal });
const rejectPending = (invokeId, error) => {
  for (const [nextId, pending] of pendingNext) if (pending.invokeId === invokeId) { pendingNext.delete(nextId); pending.reject(error); }
};
const handle = async (record) => {
  if (record.kind === "bootstrap") {
    if (bootstrapped) throw new Error("duplicate bootstrap");
    const source = Buffer.from(record.source, "base64url").toString("utf8");
    const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    if (typeof module.default === "function") await module.default(createApi(record.pluginId, record.runId));
    bootstrapped = true;
    await writes;
    await write({ kind: "ready" });
    return;
  }
  if (record.kind === "stop" && !stopping) {
    stopping = true;
    for (const [invokeId, activeInvocation] of active) { activeInvocation.abort(); rejectPending(invokeId, new Error("Dynamic plugin run stopped.")); }
    await write({ kind: "stopped" });
    process.exit(0);
    return;
  }
  if (record.kind === "cancel") {
    active.get(record.invokeId)?.abort();
    rejectPending(record.invokeId, new Error("Dynamic plugin invocation cancelled."));
    return;
  }
  if (record.kind === "middleware_next_result") {
    const pending = pendingNext.get(record.nextId);
    if (!pending) return;
    pendingNext.delete(record.nextId);
    if (record.ok) pending.resolve(record.result); else pending.reject(new Error(record.error || "middleware next failed"));
    return;
  }
  if (record.kind !== "invoke") throw new Error("unexpected dynamic plugin message");
  const entry = handlers.get(record.capabilityId);
  if (!entry) throw new Error("unknown dynamic capability");
  const controller = new AbortController();
  active.set(record.invokeId, controller);
  try {
    const context = contextFor(record, controller);
    let result;
    if (record.action === "tool") result = await entry.handler(record.payload.toolCallId, record.payload.parameters, controller.signal, context);
    else if (record.action === "prompt") result = await entry.handler(context);
    else if (record.action === "event") result = await entry.handler(record.payload.event, context);
    else {
      const next = (execution) => {
        const nextId = "next-" + (++sequence);
        const promise = new Promise((resolve, reject) => pendingNext.set(nextId, { invokeId: record.invokeId, resolve, reject }));
        void write({ version: 1, kind: "middleware_next", invokeId: record.invokeId, nextId, execution });
        return promise;
      };
      result = await entry.handler(record.payload.execution, next, context);
    }
    await write({ version: 1, kind: "invoke_result", invokeId: record.invokeId, ok: true, result });
  } catch (error) {
    await write({ version: 1, kind: "invoke_result", invokeId: record.invokeId, ok: false, error: String(error && error.message || error).slice(0, 500) });
  } finally {
    active.delete(record.invokeId);
    rejectPending(record.invokeId, new Error("Dynamic plugin invocation finished."));
  }
};
input.on("line", (line) => {
  let record;
  try { record = JSON.parse(line); } catch { void write({ kind: "error", message: "invalid bootstrap JSON" }); process.exitCode = 2; return; }
  void handle(record).catch((error) => { void write({ kind: "error", message: String(error && error.message || error).slice(0, 500) }); process.exitCode = 2; });
});
input.on("close", () => { if (!stopping) process.exitCode = 0; });
`;

/** Owns dynamic plugin child processes and never executes dynamic source in the host process. */
export class DynamicPluginBroker {
	readonly runtime = new DynamicPluginRuntime();
	private readonly options: DynamicPluginBrokerOptions;
	private reservedToolNames: readonly string[];
	private readonly runs = new Map<string, DynamicRun>();
	private readonly current = new Map<string, string>();
	private sessionStartEvent?: { readonly type: string } & Record<string, unknown>;
	private disposed = false;

	constructor(options: DynamicPluginBrokerOptions) {
		if (!options.cwd.trim()) throw new Error("Dynamic plugin broker cwd must be non-empty");
		this.options = {
			...options,
			model: options.model ?? "",
			projectTrusted: options.projectTrusted ?? false,
			reservedToolNames: [...(options.reservedToolNames ?? [])],
			killGraceMs: options.killGraceMs ?? 250,
		};
		this.reservedToolNames = [...(options.reservedToolNames ?? [])];
	}

	/** Adds host-owned tool names that dynamic capabilities must not shadow. */
	setReservedToolNames(names: readonly string[]): void {
		this.reservedToolNames = [...names];
	}

	define(definition: DynamicPackageDefinition): DynamicPackageSnapshot {
		this.assertOpen();
		return this.runtime.define(definition).snapshot();
	}

	inspect() {
		return this.runtime.inspect();
	}

	async run(packageId: string, signal?: AbortSignal): Promise<ActiveRunSnapshot> {
		this.assertOpen();
		if (signal?.aborted) throw abortError();
		const pkg = this.runtime.getPackage(packageId);
		if (!pkg) throw new Error(`Unknown package: ${packageId}`);
		await this.approve(pkg.snapshot());
		if (signal?.aborted) throw abortError();
		const response = this.runtime.handle({
			version: DYNAMIC_PLUGIN_PROTOCOL_VERSION,
			id: `plugin-run-${Date.now()}`,
			method: "plugin_run",
			params: { packageId },
		});
		if (!response.ok) throw new Error(response.error.message);
		const runId = response.result.id;
		const child = this.spawnChild();
		const run = this.createRun(pkg, runId, child);
		this.runs.set(runId, run);
		const abort = () => void this.stop(runId).catch(() => undefined);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await run.ready;
			run.readyConsumed = true;
			if (signal?.aborted) throw abortError();
			this.runtime.activateRun(runId);
			this.current.set(pkg.pluginId, runId);
			if (this.sessionStartEvent) await this.deliverEvent(run, this.sessionStartEvent, signal);
			return this.runtime.getRun(runId)?.snapshot() ?? runSnapshot(this.runtime, runId);
		} catch (cause) {
			if (!run.cleanupPromise) await this.fail(run, pkg.pluginId, cause);
			throw cause;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async update(definition: DynamicPackageDefinition, signal?: AbortSignal): Promise<ActiveRunSnapshot> {
		const next = this.define(definition);
		const previous = this.current.get(definition.pluginId);
		try {
			const started = await this.run(next.id, signal);
			if (previous !== undefined && previous !== started.id) await this.stop(previous);
			return started;
		} catch (cause) {
			this.reportDiagnostic({ pluginId: definition.pluginId, stage: "cleanup", message: safeMessage(cause) });
			throw cause;
		}
	}

	async stop(runId: string): Promise<ActiveRunSnapshot> {
		const run = this.runs.get(runId);
		if (!run) {
			const existing = this.runtime.getRun(runId);
			if (!existing) throw new Error(`Unknown run: ${runId}`);
			return existing.snapshot();
		}
		if (run.cleanupPromise) {
			await run.cleanupPromise;
			return runSnapshot(this.runtime, runId);
		}
		const pkg = this.runtime.getPackage(run.packageId);
		run.cleanupPromise = this.stopRun(run, pkg?.pluginId);
		await run.cleanupPromise;
		return runSnapshot(this.runtime, runId);
	}

	async remove(packageId: string): Promise<void> {
		const pkg = this.runtime.getPackage(packageId);
		if (!pkg) throw new Error(`Unknown package: ${packageId}`);
		for (const run of [...this.runs.values()]) if (run.packageId === packageId) await this.stop(run.runId);
		this.runtime.remove(packageId);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const failures: unknown[] = [];
		for (const run of [...this.runs.values()]) {
			try {
				await this.stop(run.runId);
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Dynamic plugin broker disposal failed");
	}

	/** Exposes the broker as model tools; execution remains subject to approval and mode checks. */
	createTools(): readonly AgentTool[] {
		return [
			{
				name: "plugin_inspect",
				description: "Inspect dynamic plugin packages and runs.",
				parameters: Type.Object({}),
				execute: async () => jsonResult(this.inspect()),
			},
			{
				name: "plugin_define",
				description: "Define dynamic plugin source without executing it.",
				parameters: definitionSchema(),
				execute: async (_id, value) => jsonResult(this.define(value as DynamicPackageDefinition)),
			},
			{
				name: "plugin_run",
				description: "Run an approved dynamic plugin package.",
				parameters: Type.Object({ packageId: Type.String({ minLength: 1, maxLength: 128 }) }),
				execute: async (_id, value, signal) =>
					jsonResult(await this.run((value as { packageId: string }).packageId, signal)),
			},
			{
				name: "plugin_update",
				description: "Define and run a replacement dynamic plugin; the old run stays active if it fails.",
				parameters: definitionSchema(),
				execute: async (_id, value, signal) => jsonResult(await this.update(value as DynamicPackageDefinition, signal)),
			},
			{
				name: "plugin_stop",
				description: "Stop a dynamic plugin run.",
				parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }) }),
				execute: async (_id, value) => jsonResult(await this.stop((value as { runId: string }).runId)),
			},
			{
				name: "plugin_remove",
				description: "Stop and remove a dynamic plugin package.",
				parameters: Type.Object({ packageId: Type.String({ minLength: 1, maxLength: 128 }) }),
				execute: async (_id, value) => {
					await this.remove((value as { packageId: string }).packageId);
					return [{ type: "text", text: "Dynamic plugin package removed." }];
				},
			},
		];
	}

	/** Resolves active dynamic capabilities into the Agent request snapshot. */
	getContextProvider(): AgentContextProvider {
		return { resolve: (signal) => this.resolveContext(signal) };
	}

	async resolveContext(signal?: AbortSignal): Promise<AgentRequestContext> {
		const tools: AgentTool[] = [];
		const middleware: ToolExecutionMiddleware[] = [];
		const prompts: Array<{ order: number; id: string; run: DynamicRun; capabilityId: string }> = [];
		for (const run of this.activeRuns()) {
			const snapshot = this.runtime.getRun(run.runId)?.snapshot();
			for (const capability of snapshot?.capabilities ?? []) {
				if (capability.type === "tool") tools.push(this.createDynamicTool(run, capability));
				else if (capability.type === "middleware") middleware.push(this.createDynamicMiddleware(run, capability));
				else if (capability.type === "prompt")
					prompts.push({ order: capability.order, id: capability.id, run, capabilityId: capability.id });
			}
		}
		prompts.sort((a, b) => a.order - b.order || a.run.runId.localeCompare(b.run.runId) || a.id.localeCompare(b.id));
		const rendered: string[] = [];
		for (const prompt of prompts) {
			try {
				const value = await this.invoke(prompt.run, prompt.capabilityId, "prompt", {}, signal);
				if (typeof value === "string" && value) rendered.push(value);
			} catch (cause) {
				this.reportDiagnostic({
					pluginId: prompt.run.pluginId,
					runId: prompt.run.runId,
					stage: "protocol",
					message: safeMessage(cause),
				});
				throw new Error(`Dynamic plugin prompt section "${prompt.id}" failed`, { cause });
			}
		}
		return {
			systemPrompt: rendered.length > 0 ? rendered.join("\n\n") : undefined,
			tools,
			toolMiddleware: middleware,
		};
	}

	/** Delivers an Agent lifecycle event to active dynamic event capabilities. */
	async emit(event: { readonly type: string } & Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		if (event.type === "session_start") this.sessionStartEvent = { ...event };
		if (event.type === "session_shutdown") this.sessionStartEvent = undefined;
		for (const run of this.activeRuns()) {
			await this.deliverEvent(run, event, signal);
		}
	}

	private async deliverEvent(
		run: DynamicRun,
		event: { readonly type: string } & Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void> {
		const capabilities = this.runtime.getRun(run.runId)?.snapshot().capabilities ?? [];
		for (const capability of capabilities) {
			if (capability.type !== "event" || capability.event !== event.type) continue;
			try {
				await this.invoke(run, capability.id, "event", { event }, signal);
			} catch (cause) {
				this.reportDiagnostic({
					pluginId: run.pluginId,
					runId: run.runId,
					stage: "protocol",
					message: safeMessage(cause),
				});
			}
		}
	}

	private activeRuns(): DynamicRun[] {
		return [...this.runs.values()].filter((run) => this.runtime.getRun(run.runId)?.state === "active");
	}

	private createDynamicTool(run: DynamicRun, capability: DynamicPluginToolCapability): AgentTool {
		if (this.reservedToolNames.includes(capability.name))
			throw new Error(`Dynamic plugin tool conflicts with host tool: ${capability.name}`);
		return {
			name: capability.name,
			description: capability.description,
			parameters: capability.parameters as never,
			execute: async (toolCallId, parameters, signal) => {
				const result = await this.invoke(run, capability.id, "tool", { toolCallId, parameters }, signal);
				return parseAgentToolResult(result);
			},
		};
	}

	private createDynamicMiddleware(
		run: DynamicRun,
		capability: DynamicPluginMiddlewareCapability,
	): ToolExecutionMiddleware {
		return async (execution, next) => {
			const invokeId = `invoke-${Date.now()}-${++invocationSequence}`;
			run.nexts.set(invokeId, async (payload) => {
				const parameters = payload.parameters === undefined ? execution.parameters : payload.parameters;
				return next({ ...execution, parameters });
			});
			try {
				const value = await this.invoke(
					run,
					capability.id,
					"middleware",
					{
						execution: {
							toolCallId: execution.toolCallId,
							toolName: execution.tool.name,
							parameters: execution.parameters,
						},
					},
					execution.signal,
					invokeId,
				);
				return parseAgentToolResult(value);
			} finally {
				run.nexts.delete(invokeId);
			}
		};
	}

	private async invoke(
		run: DynamicRun,
		capabilityId: string,
		action: "tool" | "prompt" | "middleware" | "event",
		payload: Record<string, unknown>,
		signal?: AbortSignal,
		invokeId = `invoke-${Date.now()}-${++invocationSequence}`,
	): Promise<unknown> {
		if (signal?.aborted) throw abortError();
		if (run.settled || this.runtime.getRun(run.runId)?.state !== "active")
			throw new Error("Dynamic plugin run is not active.");
		const context: DynamicPluginContextWire = {
			cwd: this.options.cwd,
			mode: this.options.mode,
			isProjectTrusted: this.options.projectTrusted === true,
			model: this.options.model ?? "",
		};
		let rejectInvocation!: (cause: unknown) => void;
		const result = new Promise<unknown>((resolve, reject) => {
			rejectInvocation = reject;
			run.pending.set(invokeId, { resolve, reject, signal });
		});
		void result.catch(() => undefined);
		const abort = () => {
			run.pending.delete(invokeId);
			void writeChildRecord(run.child, { version: 1, kind: "cancel", invokeId }).catch(() => undefined);
			queueMicrotask(() => rejectInvocation(abortError()));
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await writeChildRecord(run.child, {
				version: 1,
				kind: "invoke",
				invokeId,
				capabilityId,
				action,
				context,
				payload,
			});
			return await result;
		} finally {
			signal?.removeEventListener("abort", abort);
			run.pending.delete(invokeId);
		}
	}

	private async approve(pkg: DynamicPackageSnapshot): Promise<void> {
		if (this.options.mode !== "interactive" || this.options.allowDynamicPlugins !== true) {
			this.reportDiagnostic({
				pluginId: pkg.pluginId,
				stage: "approval",
				message: "Dynamic plugin execution is disabled outside an approved interactive run.",
			});
			throw new Error("Dynamic plugin execution is disabled; use interactive mode with --allow-dynamic-plugins.");
		}
		if (!this.options.confirmRun) throw new Error("Dynamic plugin execution requires explicit user approval.");
		const approved = await this.options.confirmRun({
			pluginId: pkg.pluginId,
			version: pkg.version,
			capabilities: pkg.capabilities,
			sourceHash: pkg.sourceHash,
			sourceBytes: pkg.sourceBytes,
			impact: "executes-session-code",
		});
		if (!approved) throw new Error("Dynamic plugin execution was not approved.");
	}

	private spawnChild(): ChildProcessWithoutNullStreams {
		try {
			return spawn(process.execPath, ["--input-type=module", "-e", BOOTSTRAP], {
				cwd: this.options.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: minimalEnvironment(),
			});
		} catch (cause) {
			this.reportDiagnostic({ stage: "spawn", message: safeMessage(cause) });
			throw cause;
		}
	}

	private createRun(pkg: Package, runId: string, child: ChildProcessWithoutNullStreams): DynamicRun {
		let resolveReady!: () => void;
		let rejectReady!: (cause: unknown) => void;
		let readyState: "pending" | "resolved" | "rejected" = "pending";
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = () => {
				if (readyState !== "pending") return;
				readyState = "resolved";
				resolve();
			};
			rejectReady = (cause) => {
				if (readyState !== "pending") return;
				readyState = "rejected";
				reject(cause);
			};
		});
		let buffer = "";
		let outputBytes = 0;
		const decoder = new StringDecoder("utf8");
		const run: DynamicRun = {
			packageId: pkg.id,
			pluginId: pkg.pluginId,
			runId,
			child,
			ready,
			rejectReady,
			settled: false,
			readyConsumed: false,
			pending: new Map(),
			nexts: new Map(),
		};
		const timeout = setTimeout(() => {
			const error = new Error("Dynamic plugin run timed out.");
			run.cleanupPromise ??= this.fail(run, pkg.pluginId, error, "timeout");
		}, pkg.limits.timeoutMs);
		child.stdout.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
			outputBytes += Buffer.byteLength(text, "utf8");
			if (outputBytes > pkg.limits.maxOutputBytes) {
				const error = new Error(`Dynamic plugin output exceeds ${pkg.limits.maxOutputBytes} bytes.`);
				this.reportDiagnostic({ pluginId: pkg.pluginId, runId, stage: "protocol", message: error.message });
				rejectReady(error);
				this.kill(child);
				return;
			}
			buffer += text;
			if (Buffer.byteLength(buffer, "utf8") > DYNAMIC_PLUGIN_MAX_LINE_BYTES) {
				this.reportDiagnostic({
					pluginId: pkg.pluginId,
					runId,
					stage: "protocol",
					message: "Dynamic plugin output line exceeds the size limit.",
				});
				rejectReady(new Error("Dynamic plugin protocol line exceeds the size limit."));
				this.kill(child);
				return;
			}
			while (true) {
				const index = buffer.indexOf("\n");
				if (index < 0) break;
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				this.acceptChildRecord(pkg.snapshot(), runId, line, resolveReady, rejectReady);
			}
		});
		child.stderr.on("data", (chunk: Buffer | string) =>
			this.reportDiagnostic({ pluginId: pkg.pluginId, runId, stage: "stderr", message: safeMessage(chunk) }),
		);
		child.stdin.on("error", (cause) => {
			const error = new Error(safeMessage(cause));
			run.cleanupPromise ??= this.fail(run, pkg.pluginId, error, "protocol");
		});
		child.once("error", (cause) => {
			const error = new Error(safeMessage(cause));
			run.cleanupPromise ??= this.fail(run, pkg.pluginId, error, "exit");
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (!run.settled) {
				const error = new Error(`Dynamic plugin process exited unexpectedly (${signal ?? code ?? "code 0"}).`);
				run.cleanupPromise ??= this.fail(run, pkg.pluginId, error, "exit");
			}
		});
		void writeChild(child, {
			kind: "bootstrap",
			pluginId: pkg.pluginId,
			runId,
			source: Buffer.from(pkg.source, "utf8").toString("base64url"),
		}).catch((cause) => {
			const error = new Error(safeMessage(cause));
			run.cleanupPromise ??= this.fail(run, pkg.pluginId, error, "protocol");
		});
		return run;
	}

	private acceptChildRecord(
		pkg: DynamicPackageSnapshot,
		runId: string,
		line: string,
		resolveReady: () => void,
		rejectReady: (cause: unknown) => void,
	): void {
		let record: ChildRecord;
		try {
			if (Buffer.byteLength(line, "utf8") > DYNAMIC_PLUGIN_MAX_LINE_BYTES) throw new Error("line exceeds size limit");
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && "method" in parsed) {
				const capability = parseDynamicPluginCapabilityRecord(parsed);
				if (capability.params.runId !== runId || capability.params.pluginId !== pkg.pluginId)
					throw new Error("dynamic capability ownership mismatch");
				const requiredCapability =
					capability.method === "capability_register"
						? declaredCapability(capability.params.capability.type)
						: undefined;
				if (
					requiredCapability !== undefined &&
					!declaredCapabilityAliases(requiredCapability).some((name) => pkg.capabilities.includes(name))
				)
					throw new Error(`dynamic capability "${requiredCapability}" was not declared by the package`);
				if (
					capability.method === "capability_register" &&
					capability.params.capability.type === "tool" &&
					this.reservedToolNames.includes(capability.params.capability.name)
				)
					throw new Error(`Dynamic plugin tool conflicts with host tool: ${capability.params.capability.name}`);
				if (capability.method === "capability_register")
					this.runtime.registerCapability(runId, capability.params.capability);
				else this.runtime.revokeCapability(runId, capability.params.capabilityId);
				return;
			}
			if (
				parsed &&
				typeof parsed === "object" &&
				"kind" in parsed &&
				(parsed.kind === "invoke_result" || parsed.kind === "middleware_next")
			) {
				const invocation = parseDynamicPluginChildInvocationRecord(parsed);
				if (invocation.kind === "invoke_result") this.resolveInvocation(runId, invocation);
				else this.resolveMiddlewareNext(runId, invocation);
				return;
			}
			record = parsed as ChildRecord;
			if (record.kind !== "ready" && record.kind !== "stopped" && record.kind !== "error")
				throw new Error("unknown child record");
		} catch (cause) {
			const error = new Error(`Invalid dynamic plugin protocol: ${safeMessage(cause)}`);
			this.reportDiagnostic({ pluginId: pkg.pluginId, runId, stage: "protocol", message: error.message });
			rejectReady(error);
			this.kill(this.runs.get(runId)?.child);
			return;
		}
		if (record.kind === "ready") resolveReady();
		if (record.kind === "error") {
			const message = safeMessage(record.message ?? "Dynamic plugin child failed.");
			this.reportDiagnostic({ pluginId: pkg.pluginId, runId, stage: "exit", message });
			rejectReady(new Error(message));
		}
	}

	private resolveInvocation(runId: string, record: DynamicPluginChildInvocationRecord): void {
		if (record.kind !== "invoke_result") throw new Error("invalid invocation result");
		const run = this.runs.get(runId);
		if (!run || record.invokeId === undefined) throw new Error("unknown dynamic invocation");
		const pending = run.pending.get(record.invokeId);
		if (!pending) return;
		run.pending.delete(record.invokeId);
		if (record.ok) pending.resolve(record.result);
		else pending.reject(new Error(safeMessage(record.error ?? "Dynamic plugin invocation failed.")));
	}

	private resolveMiddlewareNext(runId: string, record: DynamicPluginChildInvocationRecord): void {
		if (record.kind !== "middleware_next") throw new Error("invalid middleware next request");
		const run = this.runs.get(runId);
		if (!run) throw new Error("unknown dynamic run");
		const next = run.nexts.get(record.nextId) ?? run.nexts.get(record.invokeId);
		if (!next) throw new Error("unknown middleware next callback");
		run.nexts.delete(record.nextId);
		void next(record.execution)
			.then((result) =>
				writeChildRecord(run.child, {
					version: 1,
					kind: "middleware_next_result",
					nextId: record.nextId,
					ok: true,
					result,
				}),
			)
			.catch((cause) =>
				writeChildRecord(run.child, {
					version: 1,
					kind: "middleware_next_result",
					nextId: record.nextId,
					ok: false,
					error: safeMessage(cause),
				}),
			)
			.catch((cause) => this.reportDiagnostic({ runId, stage: "protocol", message: safeMessage(cause) }));
	}

	private fail(
		run: DynamicRun,
		pluginId: string,
		cause: unknown,
		stage: DynamicPluginDiagnostic["stage"] = "cleanup",
	): Promise<void> {
		run.cleanupPromise = (async () => {
			const message = safeMessage(cause);
			const wasStarting = this.runtime.getRun(run.runId)?.state === "starting";
			if (wasStarting && !run.readyConsumed) run.rejectReady(new Error(message));
			this.reportDiagnostic({ pluginId, runId: run.runId, stage, message });
			try {
				this.runtime.fail(run.runId, message);
			} catch {
				// Preserve the original failure when the runtime is already terminal.
			}
			for (const pending of run.pending.values()) pending.reject(new Error(message));
			run.pending.clear();
			run.nexts.clear();
			run.settled = true;
			this.kill(run.child);
			await waitForExit(run.child, this.options.killGraceMs ?? 250);
			this.runs.delete(run.runId);
			if (this.current.get(pluginId) === run.runId) this.current.delete(pluginId);
		})();
		return run.cleanupPromise;
	}

	private stopRun(run: DynamicRun, pluginId: string | undefined): Promise<void> {
		run.settled = true;
		if (this.runtime.getRun(run.runId)?.state === "starting" && !run.readyConsumed) run.rejectReady(abortError());
		return (async () => {
			try {
				this.runtime.handle({
					version: 1,
					id: `plugin-stop-${Date.now()}`,
					method: "plugin_stop",
					params: { runId: run.runId },
				});
				await writeChild(run.child, { kind: "stop" });
				await waitForExit(run.child, this.options.killGraceMs ?? 250);
				this.runtime.stop(run.runId);
			} catch (cause) {
				const message = safeMessage(cause);
				this.reportDiagnostic({ pluginId, runId: run.runId, stage: "cleanup", message });
				this.runtime.fail(run.runId, message);
				this.kill(run.child);
			} finally {
				for (const pending of run.pending.values()) pending.reject(abortError());
				run.pending.clear();
				run.nexts.clear();
				this.runs.delete(run.runId);
				if (pluginId && this.current.get(pluginId) === run.runId) this.current.delete(pluginId);
			}
		})();
	}

	private kill(child: ChildProcessWithoutNullStreams | undefined): void {
		if (!child || child.killed) return;
		try {
			child.kill();
		} catch (cause) {
			this.reportDiagnostic({ stage: "cleanup", message: safeMessage(cause) });
		}
	}

	private reportDiagnostic(diagnostic: DynamicPluginDiagnostic): void {
		this.options.onDiagnostic?.(diagnostic);
	}
	private assertOpen(): void {
		if (this.disposed) throw new Error("Dynamic plugin broker is disposed.");
	}
}

function definitionSchema() {
	return Type.Object({
		pluginId: Type.String({ minLength: 1, maxLength: 64 }),
		version: Type.String({ minLength: 1, maxLength: 128 }),
		runtimeVersion: Type.String({ minLength: 1, maxLength: 64 }),
		source: Type.String({ minLength: 1, maxLength: 1_048_576 }),
		capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64 }),
		limits: Type.Optional(
			Type.Object({
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
				maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1 })),
			}),
		),
	});
}

function jsonResult(value: unknown): ToolResultContent[] {
	return [{ type: "text", text: JSON.stringify(value) }];
}

function parseAgentToolResult(value: unknown): ToolResultContent[] {
	const content = Array.isArray(value)
		? value
		: value && typeof value === "object" && "content" in value
			? value.content
			: undefined;
	if (!Array.isArray(content)) throw new Error("Dynamic plugin tool result must contain an array of content blocks.");
	for (const block of content) {
		if (!block || typeof block !== "object" || (block as { type?: unknown }).type === undefined)
			throw new Error("Dynamic plugin tool result contains an invalid content block.");
		const type = (block as { type: unknown }).type;
		if (type === "text" && typeof (block as { text?: unknown }).text !== "string")
			throw new Error("Dynamic plugin text result must contain text.");
		if (
			type === "image" &&
			(typeof (block as { data?: unknown }).data !== "string" ||
				typeof (block as { mimeType?: unknown }).mimeType !== "string")
		)
			throw new Error("Dynamic plugin image result must contain data and mimeType.");
		if (type !== "text" && type !== "image")
			throw new Error("Dynamic plugin result contains an unsupported content type.");
	}
	return content as ToolResultContent[];
}
function runSnapshot(runtime: DynamicPluginRuntime, runId: string): ActiveRunSnapshot {
	const run = runtime.getRun(runId);
	if (!run) throw new Error(`Unknown run: ${runId}`);
	return run.snapshot();
}
function safeMessage(cause: unknown): string {
	const value = cause instanceof Error ? cause.message : String(cause);
	return value
		.replace(/(api[_-]?key|token|secret|authorization|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
		.slice(0, 500);
}
function declaredCapability(type: "tool" | "prompt" | "middleware" | "event"): string {
	return type === "tool" ? "tools" : type === "prompt" ? "prompts" : type === "middleware" ? "middleware" : "events";
}
function declaredCapabilityAliases(value: string): readonly string[] {
	return value === "tools"
		? ["tools", "tool"]
		: value === "prompts"
			? ["prompts", "prompt"]
			: value === "middleware"
				? ["middleware", "middlewares"]
				: ["events", "event"];
}
function abortError(): Error {
	const error = new Error("Dynamic plugin run was cancelled.");
	error.name = "AbortError";
	return error;
}
function minimalEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "SystemRoot", "COMSPEC", "TEMP", "TMP"])
		if (process.env[key]) env[key] = process.env[key];
	return env;
}
function writeChild(child: ChildProcessWithoutNullStreams, record: Record<string, unknown>): Promise<void> {
	const line = `${JSON.stringify(record)}\n`;
	return new Promise((resolve, reject) => {
		try {
			if (child.stdin.destroyed || child.stdin.writableEnded) {
				reject(new Error("Dynamic plugin child stdin is closed."));
				return;
			}
			child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
		} catch (cause) {
			reject(cause);
		}
	});
}
const writeChildRecord = writeChild;
function waitForExit(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		let done = false;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			resolve();
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			forceTimer = setTimeout(finish, Math.max(100, graceMs * 4));
		}, graceMs);
		child.once("close", finish);
	});
}
