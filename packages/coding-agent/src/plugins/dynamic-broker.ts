import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@di-code/agent";
import { type ToolResultContent, Type } from "@di-code/ai";
import {
	type ActiveRunSnapshot,
	DYNAMIC_PLUGIN_MAX_LINE_BYTES,
	DYNAMIC_PLUGIN_PROTOCOL_VERSION,
	type DynamicPackageDefinition,
	type DynamicPackageSnapshot,
	DynamicPluginRuntime,
	type Package,
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
	readonly runId: string;
	readonly child: ChildProcessWithoutNullStreams;
	readonly ready: Promise<void>;
	readonly rejectReady: (cause: unknown) => void;
	settled: boolean;
	readyConsumed: boolean;
	cleanupPromise?: Promise<void>;
}

interface ChildRecord {
	readonly kind: "ready" | "stopped" | "error";
	readonly message?: string;
}

const BOOTSTRAP = String.raw`
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
let stopping = false;
const write = (record) => process.stdout.write(JSON.stringify(record) + "\n");
try {
  for await (const line of input) {
    let record;
    try { record = JSON.parse(line); } catch { write({ kind: "error", message: "invalid bootstrap JSON" }); process.exitCode = 2; break; }
    if (record.kind === "bootstrap") {
      try {
        const source = Buffer.from(record.source, "base64url").toString("utf8");
        const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
        if (typeof module.default === "function") await module.default({ signal: undefined });
        write({ kind: "ready" });
      } catch (error) {
        write({ kind: "error", message: String(error && error.message || error).slice(0, 500) });
        process.exitCode = 2;
        break;
      }
    } else if (record.kind === "stop" && !stopping) {
      stopping = true;
      write({ kind: "stopped" });
      process.exit(0);
    } else {
      write({ kind: "error", message: "unexpected dynamic plugin message" });
      process.exitCode = 2;
      break;
    }
  }
} catch (error) {
  write({ kind: "error", message: String(error && error.message || error).slice(0, 500) });
  process.exitCode = 2;
}
`;

/** Owns dynamic plugin child processes and never executes dynamic source in the host process. */
export class DynamicPluginBroker {
	readonly runtime = new DynamicPluginRuntime();
	private readonly options: DynamicPluginBrokerOptions;
	private readonly runs = new Map<string, DynamicRun>();
	private readonly current = new Map<string, string>();
	private disposed = false;

	constructor(options: DynamicPluginBrokerOptions) {
		if (!options.cwd.trim()) throw new Error("Dynamic plugin broker cwd must be non-empty");
		this.options = { ...options, killGraceMs: options.killGraceMs ?? 250 };
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
			this.emit({ pluginId: definition.pluginId, stage: "cleanup", message: safeMessage(cause) });
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

	private async approve(pkg: DynamicPackageSnapshot): Promise<void> {
		if (this.options.mode !== "interactive" || this.options.allowDynamicPlugins !== true) {
			this.emit({
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
			this.emit({ stage: "spawn", message: safeMessage(cause) });
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
			runId,
			child,
			ready,
			rejectReady,
			settled: false,
			readyConsumed: false,
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
				this.emit({ pluginId: pkg.pluginId, runId, stage: "protocol", message: error.message });
				rejectReady(error);
				this.kill(child);
				return;
			}
			buffer += text;
			if (Buffer.byteLength(buffer, "utf8") > DYNAMIC_PLUGIN_MAX_LINE_BYTES) {
				this.emit({
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
			this.emit({ pluginId: pkg.pluginId, runId, stage: "stderr", message: safeMessage(chunk) }),
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
		void writeChild(child, { kind: "bootstrap", source: Buffer.from(pkg.source, "utf8").toString("base64url") }).catch(
			(cause) => {
				const error = new Error(safeMessage(cause));
				run.cleanupPromise ??= this.fail(run, pkg.pluginId, error, "protocol");
			},
		);
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
			record = JSON.parse(line) as ChildRecord;
			if (record.kind !== "ready" && record.kind !== "stopped" && record.kind !== "error")
				throw new Error("unknown child record");
		} catch (cause) {
			const error = new Error(`Invalid dynamic plugin protocol: ${safeMessage(cause)}`);
			this.emit({ pluginId: pkg.pluginId, runId, stage: "protocol", message: error.message });
			rejectReady(error);
			this.kill(this.runs.get(runId)?.child);
			return;
		}
		if (record.kind === "ready") resolveReady();
		if (record.kind === "error") {
			const message = safeMessage(record.message ?? "Dynamic plugin child failed.");
			this.emit({ pluginId: pkg.pluginId, runId, stage: "exit", message });
			rejectReady(new Error(message));
		}
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
			this.emit({ pluginId, runId: run.runId, stage, message });
			try {
				this.runtime.fail(run.runId, message);
			} catch {
				// Preserve the original failure when the runtime is already terminal.
			}
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
				this.emit({ pluginId, runId: run.runId, stage: "cleanup", message });
				this.runtime.fail(run.runId, message);
				this.kill(run.child);
			} finally {
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
			this.emit({ stage: "cleanup", message: safeMessage(cause) });
		}
	}

	private emit(diagnostic: DynamicPluginDiagnostic): void {
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
function writeChild(child: ChildProcessWithoutNullStreams, record: Record<string, string>): Promise<void> {
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
