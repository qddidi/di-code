import { createHash } from "node:crypto";

export const DYNAMIC_PLUGIN_PROTOCOL_VERSION = 1 as const;
export const DYNAMIC_PLUGIN_MAX_SOURCE_BYTES = 1_048_576;
export const DYNAMIC_PLUGIN_MAX_LINE_BYTES = 2_097_152;

export type DynamicPackageState = "defined";
export type ActiveRunState = "starting" | "active" | "stopping" | "stopped" | "failed";
export type DynamicPluginRpcMethod = "plugin_define" | "plugin_run" | "plugin_stop";

export interface DynamicPluginLimits {
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

export interface DynamicPackageDefinition {
	readonly pluginId: string;
	readonly version: string;
	readonly runtimeVersion: string;
	readonly source: string;
	readonly capabilities: readonly string[];
	readonly limits?: Partial<DynamicPluginLimits>;
}

export interface DynamicPackageSnapshot {
	readonly id: string;
	readonly pluginId: string;
	readonly version: string;
	readonly runtimeVersion: string;
	readonly sourceHash: string;
	readonly sourceBytes: number;
	readonly capabilities: readonly string[];
	readonly limits: DynamicPluginLimits;
	readonly state: DynamicPackageState;
	readonly createdAt: number;
}

export interface ActiveRunSnapshot {
	readonly id: string;
	readonly packageId: string;
	readonly pluginId: string;
	readonly state: ActiveRunState;
	readonly startedAt: number;
	readonly stoppedAt?: number;
	readonly failure?: string;
}

export class Package {
	readonly state: DynamicPackageState = "defined";
	readonly id: string;
	readonly pluginId: string;
	readonly version: string;
	readonly runtimeVersion: string;
	readonly source: string;
	readonly sourceHash: string;
	readonly sourceBytes: number;
	readonly capabilities: readonly string[];
	readonly limits: DynamicPluginLimits;
	readonly createdAt: number;

	constructor(id: string, definition: DynamicPackageDefinition, now = Date.now()) {
		validatePackageDefinition(definition);
		nonEmpty(id, "package id");
		this.id = id;
		this.pluginId = definition.pluginId;
		this.version = definition.version;
		this.runtimeVersion = definition.runtimeVersion;
		this.source = definition.source;
		this.sourceHash = createHash("sha256").update(definition.source).digest("hex");
		this.sourceBytes = Buffer.byteLength(definition.source, "utf8");
		this.capabilities = Object.freeze([...definition.capabilities]);
		this.limits = Object.freeze(normalizeLimits(definition.limits));
		this.createdAt = now;
		Object.freeze(this);
	}

	snapshot(): DynamicPackageSnapshot {
		return {
			id: this.id,
			pluginId: this.pluginId,
			version: this.version,
			runtimeVersion: this.runtimeVersion,
			sourceHash: this.sourceHash,
			sourceBytes: this.sourceBytes,
			capabilities: [...this.capabilities],
			limits: { ...this.limits },
			state: this.state,
			createdAt: this.createdAt,
		};
	}
}

export class ActiveRun {
	private _state: ActiveRunState = "starting";
	private _stoppedAt?: number;
	private _failure?: string;
	readonly id: string;
	readonly packageId: string;
	readonly pluginId: string;
	readonly startedAt: number;

	constructor(id: string, pkg: Package, now = Date.now()) {
		nonEmpty(id, "run id");
		this.id = id;
		this.packageId = pkg.id;
		this.pluginId = pkg.pluginId;
		this.startedAt = now;
	}

	get state(): ActiveRunState {
		return this._state;
	}

	/** Marks the run ready for broker contributions. No process is started here. */
	activate(): void {
		if (this._state === "active") return;
		this.transition(["starting"], "active");
	}

	beginStop(): void {
		if (this._state === "stopping" || this._state === "stopped" || this._state === "failed") return;
		this.transition(["starting", "active"], "stopping");
	}

	/** Stops the run idempotently. A failed run keeps its failure terminal state. */
	stop(now = Date.now()): void {
		if (this._state === "stopped" || this._state === "failed") return;
		this.transition(["starting", "active", "stopping"], "stopped");
		this._stoppedAt = now;
	}

	fail(reason: string, now = Date.now()): void {
		if (this._state === "stopped" || this._state === "failed") return;
		nonEmpty(reason, "run failure");
		this.transition(["starting", "active", "stopping"], "failed");
		this._failure = redact(reason).slice(0, 500);
		this._stoppedAt = now;
	}

	snapshot(): ActiveRunSnapshot {
		return {
			id: this.id,
			packageId: this.packageId,
			pluginId: this.pluginId,
			state: this.state,
			startedAt: this.startedAt,
			...(this._stoppedAt === undefined ? {} : { stoppedAt: this._stoppedAt }),
			...(this._failure === undefined ? {} : { failure: this._failure }),
		};
	}

	private transition(from: readonly ActiveRunState[], to: ActiveRunState): void {
		if (!from.includes(this._state)) throw new Error(`Invalid active run transition: ${this._state} -> ${to}`);
		this._state = to;
	}
}

export class DynamicPluginRuntime {
	private readonly packages = new Map<string, Package>();
	private readonly runs = new Map<string, ActiveRun>();
	private nextPackage = 1;
	private nextRun = 1;

	define(definition: DynamicPackageDefinition, now = Date.now()): Package {
		validatePackageDefinition(definition);
		const id = `pkg-${this.nextPackage++}`;
		const pkg = new Package(id, definition, now);
		this.packages.set(id, pkg);
		return pkg;
	}

	startRun(packageId: string, now = Date.now()): ActiveRun {
		const pkg = this.requirePackage(packageId);
		const run = new ActiveRun(`run-${this.nextRun++}`, pkg, now);
		this.runs.set(run.id, run);
		return run;
	}

	/** Alias used by hosts when handling the `plugin_run` operation. */
	run(packageId: string, now = Date.now()): ActiveRun {
		return this.startRun(packageId, now);
	}

	activateRun(runId: string): ActiveRun {
		const run = this.requireRun(runId);
		run.activate();
		return run;
	}

	stop(runId: string, now = Date.now()): ActiveRun {
		const run = this.requireRun(runId);
		run.stop(now);
		return run;
	}

	fail(runId: string, reason: string, now = Date.now()): ActiveRun {
		const run = this.requireRun(runId);
		run.fail(reason, now);
		return run;
	}

	getPackage(packageId: string): Package | undefined {
		return this.packages.get(packageId);
	}

	getRun(runId: string): ActiveRun | undefined {
		return this.runs.get(runId);
	}

	listPackages(): readonly DynamicPackageSnapshot[] {
		return [...this.packages.values()].map((pkg) => pkg.snapshot());
	}

	listRuns(): readonly ActiveRunSnapshot[] {
		return [...this.runs.values()].map((run) => run.snapshot());
	}

	remove(packageId: string): void {
		this.requirePackage(packageId);
		const active = [...this.runs.values()].find(
			(run) => run.packageId === packageId && !["stopped", "failed"].includes(run.state),
		);
		if (active) throw new Error(`Cannot remove package with active run: ${active.id}`);
		this.packages.delete(packageId);
		for (const [runId, run] of this.runs) if (run.packageId === packageId) this.runs.delete(runId);
	}

	inspect(): DynamicPluginInspection {
		return { packages: this.listPackages(), runs: this.listRuns() };
	}

	handle(request: DynamicPluginRpcRequest): DynamicPluginRpcResponse {
		try {
			switch (request.method) {
				case "plugin_define":
					return { version: 1, id: request.id, ok: true, result: this.define(request.params).snapshot() };
				case "plugin_run":
					return { version: 1, id: request.id, ok: true, result: this.startRun(request.params.packageId).snapshot() };
				case "plugin_stop":
					return { version: 1, id: request.id, ok: true, result: this.stop(request.params.runId).snapshot() };
			}
		} catch (cause) {
			return {
				version: 1,
				id: request.id,
				ok: false,
				error: {
					code: classifyError(cause),
					message: redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
				},
			};
		}
	}

	private requirePackage(id: string): Package {
		const pkg = this.packages.get(id);
		if (!pkg) throw new Error(`Unknown package: ${id}`);
		return pkg;
	}

	private requireRun(id: string): ActiveRun {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown run: ${id}`);
		return run;
	}
}

export interface DynamicPluginInspection {
	readonly packages: readonly DynamicPackageSnapshot[];
	readonly runs: readonly ActiveRunSnapshot[];
}

export interface PluginDefineRequest {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly id: string;
	readonly method: "plugin_define";
	readonly params: DynamicPackageDefinition;
}
export interface PluginRunRequest {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly id: string;
	readonly method: "plugin_run";
	readonly params: { readonly packageId: string };
}
export interface PluginStopRequest {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly id: string;
	readonly method: "plugin_stop";
	readonly params: { readonly runId: string };
}
export type DynamicPluginRpcRequest = PluginDefineRequest | PluginRunRequest | PluginStopRequest;
export type DynamicPluginRequest = DynamicPluginRpcRequest;

export type DynamicPluginRpcResponse =
	| {
			readonly version: 1;
			readonly id: string;
			readonly ok: true;
			readonly result: DynamicPackageSnapshot | ActiveRunSnapshot;
	  }
	| {
			readonly version: 1;
			readonly id: string;
			readonly ok: false;
			readonly error: { readonly code: string; readonly message: string };
	  };
export type DynamicPluginResponse = DynamicPluginRpcResponse;

export function parseDynamicPluginRequest(value: unknown): DynamicPluginRpcRequest {
	const record = object(value, "dynamic plugin request");
	if (record.version !== DYNAMIC_PLUGIN_PROTOCOL_VERSION)
		throw new Error("unsupported dynamic plugin protocol version");
	const id = boundedString(record.id, "request id", 128);
	const params = object(record.params, "request params");
	switch (record.method) {
		case "plugin_define":
			return { version: 1, id, method: "plugin_define", params: parseDefinition(params) };
		case "plugin_run":
			return {
				version: 1,
				id,
				method: "plugin_run",
				params: { packageId: boundedString(params.packageId, "packageId", 128) },
			};
		case "plugin_stop":
			return { version: 1, id, method: "plugin_stop", params: { runId: boundedString(params.runId, "runId", 128) } };
		default:
			throw new Error("unsupported dynamic plugin method");
	}
}

export function parseDynamicPluginJsonl(line: string): DynamicPluginRpcRequest {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > DYNAMIC_PLUGIN_MAX_LINE_BYTES)
		throw new Error("dynamic plugin JSONL line exceeds size limit");
	try {
		return parseDynamicPluginRequest(JSON.parse(line) as unknown);
	} catch (cause) {
		throw new Error(`invalid dynamic plugin JSONL: ${redact(cause instanceof Error ? cause.message : String(cause))}`, {
			cause,
		});
	}
}

export function stringifyDynamicPluginJsonl(record: DynamicPluginRpcRequest | DynamicPluginRpcResponse): string {
	const value = record as Record<string, unknown>;
	if (value.version !== DYNAMIC_PLUGIN_PROTOCOL_VERSION || typeof value.id !== "string")
		throw new Error("invalid dynamic plugin record");
	if ("method" in value) parseDynamicPluginRequest(record as DynamicPluginRpcRequest);
	else validateDynamicPluginResponse(record as DynamicPluginRpcResponse);
	const line = JSON.stringify(record);
	if (Buffer.byteLength(line, "utf8") + 1 > DYNAMIC_PLUGIN_MAX_LINE_BYTES)
		throw new Error("dynamic plugin JSONL line exceeds size limit");
	return `${line}\n`;
}

export const encodeDynamicPluginJsonl = stringifyDynamicPluginJsonl;
export const parseDynamicPluginRequestLine = parseDynamicPluginJsonl;

export function parseDynamicPluginResponse(value: unknown): DynamicPluginRpcResponse {
	const record = object(value, "dynamic plugin response");
	if (record.version !== DYNAMIC_PLUGIN_PROTOCOL_VERSION)
		throw new Error("unsupported dynamic plugin protocol version");
	if (record.ok !== true && record.ok !== false) throw new Error("response ok must be a boolean");
	const id = boundedString(record.id, "response id", 128);
	if (record.ok === false) {
		const error = object(record.error, "response error");
		return {
			version: 1,
			id,
			ok: false,
			error: {
				code: boundedString(error.code, "error code", 64),
				message: boundedString(error.message, "error message", 500),
			},
		};
	}
	if (!record.result || typeof record.result !== "object" || Array.isArray(record.result))
		throw new Error("response result must be an object");
	return { version: 1, id, ok: true, result: record.result as DynamicPackageSnapshot | ActiveRunSnapshot };
}

export function parseDynamicPluginRecord(value: unknown): DynamicPluginRpcRequest | DynamicPluginRpcResponse {
	const record = object(value, "dynamic plugin record");
	if ("method" in record) return parseDynamicPluginRequest(record);
	if ("ok" in record) return parseDynamicPluginResponse(record);
	throw new Error("dynamic plugin record must be a request or response");
}

export function parseDynamicPluginJsonlRecord(line: string): DynamicPluginRpcRequest | DynamicPluginRpcResponse {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > DYNAMIC_PLUGIN_MAX_LINE_BYTES)
		throw new Error("dynamic plugin JSONL line exceeds size limit");
	try {
		return parseDynamicPluginRecord(JSON.parse(line) as unknown);
	} catch (cause) {
		throw new Error(`invalid dynamic plugin JSONL: ${redact(cause instanceof Error ? cause.message : String(cause))}`, {
			cause,
		});
	}
}

function validateDynamicPluginResponse(value: DynamicPluginRpcResponse): void {
	const record = object(value, "dynamic plugin response");
	boundedString(record.id, "response id", 128);
	if (record.ok === false) {
		const error = object(record.error, "response error");
		boundedString(error.code, "error code", 64);
		boundedString(error.message, "error message", 500);
		return;
	}
	if (record.ok !== true || !record.result || typeof record.result !== "object")
		throw new Error("invalid dynamic plugin response");
}

function parseDefinition(params: Record<string, unknown>): DynamicPackageDefinition {
	const limits = params.limits === undefined ? undefined : object(params.limits, "limits");
	const definition: DynamicPackageDefinition = {
		pluginId: boundedString(params.pluginId, "pluginId", 64),
		version: boundedString(params.version, "version", 128),
		runtimeVersion: boundedString(params.runtimeVersion, "runtimeVersion", 64),
		source: boundedSource(params.source),
		capabilities: stringList(params.capabilities, "capabilities"),
		...(limits === undefined
			? {}
			: { limits: { timeoutMs: limits.timeoutMs as number, maxOutputBytes: limits.maxOutputBytes as number } }),
	};
	validatePackageDefinition(definition);
	return definition;
}

function validatePackageDefinition(definition: DynamicPackageDefinition): void {
	const pluginId = boundedString(definition.pluginId, "pluginId", 64);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) throw new Error("pluginId must use lowercase hyphenated form");
	boundedString(definition.version, "version", 128);
	boundedString(definition.runtimeVersion, "runtimeVersion", 64);
	boundedSource(definition.source);
	stringList(definition.capabilities, "capabilities");
	normalizeLimits(definition.limits);
}

function normalizeLimits(limits: Partial<DynamicPluginLimits> | undefined): DynamicPluginLimits {
	const timeoutMs = limits?.timeoutMs ?? 120_000;
	const maxOutputBytes = limits?.maxOutputBytes ?? 32_768;
	if (!positiveInteger(timeoutMs) || timeoutMs > 86_400_000) throw new Error("limits.timeoutMs is out of range");
	if (!positiveInteger(maxOutputBytes) || maxOutputBytes > 16_777_216)
		throw new Error("limits.maxOutputBytes is out of range");
	return { timeoutMs, maxOutputBytes };
}

function parseErrorCode(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (message.startsWith("Unknown ")) return "not_found";
	if (message.startsWith("Cannot ")) return "conflict";
	if (message.startsWith("Invalid ")) return "invalid_state";
	return "invalid_request";
}
const classifyError = parseErrorCode;

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function nonEmpty(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
}
function boundedString(value: unknown, field: string, max: number): string {
	nonEmpty(value, field);
	if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
	return value;
}
function boundedSource(value: unknown): string {
	nonEmpty(value, "source");
	if (Buffer.byteLength(value, "utf8") > DYNAMIC_PLUGIN_MAX_SOURCE_BYTES)
		throw new Error(`source exceeds ${DYNAMIC_PLUGIN_MAX_SOURCE_BYTES} bytes`);
	return value;
}
function stringList(value: unknown, field: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string" && item.trim() !== "" && item.length <= 64)
	)
		throw new Error(`${field} must be an array of non-empty strings`);
	const unique = new Set(value);
	if (unique.size !== value.length) throw new Error(`${field} must not contain duplicates`);
	return [...value];
}
function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function redact(value: string): string {
	return value.replace(/(api[_-]?key|token|secret|authorization|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
