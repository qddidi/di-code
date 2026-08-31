import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	BundleMessage,
	ExtensionId,
	HostMessage,
	JsonValue,
	ProjectionEnvelope,
	SessionId,
	TaskId,
	TaskSnapshot,
	TaskState,
} from "./freedom-stage0-contracts.ts";
import { EXTENSION_MAX_PAYLOAD_BYTES, EXTENSION_PROTOCOL_VERSION } from "./freedom-stage0-contracts.ts";

export const WEB_BUNDLE_SANDBOX_FLAGS = "allow-scripts allow-same-origin" as const;
export const WEB_BUNDLE_CSP =
	"default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'" as const;

export type WebActionValidator = (input: JsonValue) => boolean;
/** Host-owned action schemas; bundles cannot register or execute actions themselves. */
export class WebActionRegistry {
	private readonly actions = new Map<string, WebActionValidator>();
	register(name: string, validate: WebActionValidator): () => void {
		if (!/^[a-z][a-z0-9_.-]*$/u.test(name) || this.actions.has(name))
			throw new Error("INVALID_INPUT: duplicate action");
		this.actions.set(name, validate);
		let active = true;
		return () => {
			if (active) {
				active = false;
				this.actions.delete(name);
			}
		};
	}
	validate(name: string, input: JsonValue): boolean {
		return this.actions.get(name)?.(input) ?? false;
	}
}

export interface DurableTaskRecord {
	readonly type: "task_created" | "task_state" | "task_event" | "task_terminal";
	readonly taskId: TaskId;
	readonly sequence: number;
	readonly state?: TaskState;
	readonly event?: unknown;
	readonly result?: JsonValue;
	readonly idempotencyKey?: string;
	readonly timestamp: string;
	readonly sessionId?: SessionId;
	readonly parentId?: TaskId;
	readonly requestId?: string;
}

export interface TaskProjection {
	readonly snapshot: TaskSnapshot;
	readonly records: readonly DurableTaskRecord[];
	readonly lastCompleteSequence: number;
	readonly needsReconciliation: boolean;
}

/** Append-only JSONL task store. A partial final line is ignored for recovery and reported by replay. */
export class DurableTaskStore {
	private readonly path: string;
	private readonly maxRecordBytes: number;
	constructor(path: string, options: { readonly maxRecordBytes?: number } = {}) {
		this.path = path;
		this.maxRecordBytes = options.maxRecordBytes ?? EXTENSION_MAX_PAYLOAD_BYTES;
	}
	async append(record: DurableTaskRecord): Promise<void> {
		const line = JSON.stringify(record);
		if (Buffer.byteLength(line, "utf8") > this.maxRecordBytes)
			throw new Error("RESOURCE_LIMIT: task record is too large");
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${line}\n`, "utf8");
	}
	async read(taskId?: TaskId): Promise<readonly DurableTaskRecord[]> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch {
			return [];
		}
		const records: DurableTaskRecord[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const value = JSON.parse(line) as DurableTaskRecord;
				if (value.type && Number.isSafeInteger(value.sequence) && (!taskId || value.taskId === taskId))
					records.push(value);
			} catch {
				// The incomplete/corrupt tail is handled by replay as reconciliation-required.
			}
		}
		return records;
	}
}

export function replayTaskRecords(records: readonly DurableTaskRecord[], taskId: TaskId): TaskProjection {
	const ordered = [...records].filter((record) => record.taskId === taskId).sort((a, b) => a.sequence - b.sequence);
	let expected = 1;
	let state: TaskState = "needs_reconciliation";
	const label = "recovered task";
	let sessionId: SessionId | undefined;
	let terminal = false;
	let lastCompleteSequence = 0;
	for (const record of ordered) {
		if (record.sequence !== expected) break;
		if (record.type === "task_created") {
			state = (record.state as TaskState | undefined) ?? "starting";
			sessionId = record.sessionId;
		}
		if (record.state) state = record.state;
		if (record.type === "task_terminal") terminal = true;
		lastCompleteSequence = expected;
		expected += 1;
	}
	const needsReconciliation = !terminal;
	if (needsReconciliation && !terminal) state = "needs_reconciliation";
	return {
		snapshot: { version: 1, taskId, state, sequence: lastCompleteSequence, label, ...(sessionId ? { sessionId } : {}) },
		records: ordered,
		lastCompleteSequence,
		needsReconciliation,
	};
}

export interface LiveSessionRuntime<T> {
	readonly sessionId: SessionId;
	readonly signal: AbortSignal;
	readonly value: T;
	close(): Promise<void>;
}

/** Keeps live Session resources independent from whichever Session view is selected. */
export class SessionRuntimeManager<T> {
	private readonly runtimes = new Map<SessionId, LiveSessionRuntime<T>>();
	private disposed = false;
	private readonly create: (sessionId: SessionId, signal: AbortSignal) => Promise<T> | T;
	constructor(create: (sessionId: SessionId, signal: AbortSignal) => Promise<T> | T) {
		this.create = create;
	}
	async open(sessionId: SessionId): Promise<LiveSessionRuntime<T>> {
		if (this.disposed) throw new Error("DISPOSED: session runtime manager");
		const existing = this.runtimes.get(sessionId);
		if (existing) return existing;
		const controller = new AbortController();
		const value = await this.create(sessionId, controller.signal);
		const runtime: LiveSessionRuntime<T> = {
			sessionId,
			signal: controller.signal,
			value,
			close: async () => {
				if (!this.runtimes.delete(sessionId)) return;
				controller.abort();
				const candidate = value as { readonly close?: () => Promise<void> | void };
				if (candidate.close) await candidate.close();
			},
		};
		this.runtimes.set(sessionId, runtime);
		return runtime;
	}
	get(sessionId: SessionId): LiveSessionRuntime<T> | undefined {
		return this.runtimes.get(sessionId);
	}
	async close(sessionId: SessionId): Promise<void> {
		await this.runtimes.get(sessionId)?.close();
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const runtime of [...this.runtimes.values()]) await runtime.close();
	}
}

export interface BridgePort {
	postMessage(message: HostMessage | BundleMessage): void;
	addEventListener(
		type: "message",
		listener: (event: { data: BundleMessage; origin: string; source: unknown }) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: BundleMessage; origin: string; source: unknown }) => void,
	): void;
}
export interface WebBundleBridgeOptions {
	readonly pluginId: ExtensionId;
	readonly instanceId?: string;
	readonly origin: string;
	readonly source: unknown;
	readonly sessionId?: SessionId;
	readonly action?: (name: string, input: JsonValue, requestId: string) => Promise<JsonValue>;
	readonly projection?: readonly ProjectionEnvelope[];
	readonly maxPayloadBytes?: number;
}

/** Protocol-v1 host bridge with strict origin/source/nonce and structured-clone checks. */
export class WebBundleBridge {
	readonly instanceId: string;
	readonly nonce: string;
	private readonly maxPayloadBytes: number;
	private ready = false;
	private disposed = false;
	private sequence = 0;
	private readonly pending = new Map<string, Promise<JsonValue>>();
	private readonly listener: (event: { data: BundleMessage; origin: string; source: unknown }) => void;
	private readonly port: BridgePort;
	private readonly options: WebBundleBridgeOptions;
	constructor(port: BridgePort, options: WebBundleBridgeOptions) {
		this.port = port;
		this.options = options;
		this.instanceId = options.instanceId ?? randomUUID();
		this.nonce = randomUUID();
		this.maxPayloadBytes = options.maxPayloadBytes ?? EXTENSION_MAX_PAYLOAD_BYTES;
		this.listener = (event) => void this.receive(event);
		port.addEventListener("message", this.listener);
		this.send({
			type: "hello",
			protocolVersion: EXTENSION_PROTOCOL_VERSION,
			instanceId: this.instanceId,
			nonce: this.nonce,
			pluginId: options.pluginId,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
		});
	}
	private send(message: HostMessage): void {
		if (Buffer.byteLength(JSON.stringify(message), "utf8") > this.maxPayloadBytes)
			throw new Error("RESOURCE_LIMIT: bridge payload is too large");
		this.port.postMessage(message);
	}
	private async receive(event: { data: BundleMessage; origin: string; source: unknown }): Promise<void> {
		if (this.disposed || event.origin !== this.options.origin || event.source !== this.options.source) return;
		const message = event.data;
		if (message.protocolVersion !== EXTENSION_PROTOCOL_VERSION || message.instanceId !== this.instanceId) return;
		if (message.type === "ready") {
			if (message.nonce === this.nonce) {
				this.ready = true;
				this.send({
					type: "snapshot",
					protocolVersion: 1,
					instanceId: this.instanceId,
					sequence: this.sequence,
					projection: this.options.projection ?? [],
				});
			}
			return;
		}
		if (!this.ready || message.type !== "action") return;
		if (Buffer.byteLength(JSON.stringify(message), "utf8") > this.maxPayloadBytes) {
			this.send({
				type: "action_result",
				protocolVersion: 1,
				instanceId: this.instanceId,
				requestId: message.requestId,
				ok: false,
				errorCode: "RESOURCE_LIMIT",
			});
			return;
		}
		if (this.pending.has(message.requestId)) return;
		const promise = (async () => {
			try {
				const value = this.options.action
					? await this.options.action(message.action, message.input, message.requestId)
					: null;
				this.send({
					type: "action_result",
					protocolVersion: 1,
					instanceId: this.instanceId,
					requestId: message.requestId,
					ok: true,
					value,
				});
				return value;
			} catch {
				this.send({
					type: "action_result",
					protocolVersion: 1,
					instanceId: this.instanceId,
					requestId: message.requestId,
					ok: false,
					errorCode: "FAILED",
				});
				return null;
			}
		})();
		this.pending.set(message.requestId, promise);
		await promise;
		this.pending.delete(message.requestId);
	}
	publish(projection: ProjectionEnvelope): void {
		if (!this.ready || this.disposed) return;
		this.sequence += 1;
		this.send({ type: "event", protocolVersion: 1, instanceId: this.instanceId, sequence: this.sequence, projection });
	}
	requireSnapshot(reason = "sequence gap"): void {
		if (!this.disposed)
			this.send({ type: "snapshot_required", protocolVersion: 1, instanceId: this.instanceId, reason });
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.ready = false;
		this.port.removeEventListener("message", this.listener);
		this.pending.clear();
	}
}
