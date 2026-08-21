import { createHash } from "node:crypto";

export const DYNAMIC_PLUGIN_PROTOCOL_VERSION = 1 as const;
export const DYNAMIC_PLUGIN_MAX_SOURCE_BYTES = 1_048_576;
export const DYNAMIC_PLUGIN_MAX_LINE_BYTES = 2_097_152;
export const DYNAMIC_PLUGIN_MAX_CAPABILITY_BYTES = 262_144;

export type DynamicPackageState = "defined";
export type ActiveRunState = "starting" | "active" | "stopping" | "stopped" | "failed";
export type DynamicPluginRpcMethod = "plugin_define" | "plugin_run" | "plugin_stop";
export type DynamicPluginCapabilityMethod = "capability_register" | "capability_revoke";

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
	readonly capabilities: readonly DynamicPluginCapability[];
}

export type DynamicPluginCapability =
	| DynamicPluginToolCapability
	| DynamicPluginPromptCapability
	| DynamicPluginMiddlewareCapability
	| DynamicPluginEventCapability;
export interface DynamicPluginToolCapability {
	readonly type: "tool";
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}
export interface DynamicPluginPromptCapability {
	readonly type: "prompt";
	readonly id: string;
	readonly order: number;
}
export interface DynamicPluginMiddlewareCapability {
	readonly type: "middleware";
	readonly id: string;
}
export interface DynamicPluginEventCapability {
	readonly type: "event";
	readonly id: string;
	readonly event: string;
}

/** JSON-safe context sent to a dynamic plugin invocation. The child adds its local AbortSignal. */
export interface DynamicPluginContext {
	readonly cwd: string;
	readonly mode: "interactive" | "print" | "json";
	readonly isProjectTrusted: boolean;
	readonly model: string;
}

export type DynamicPluginInvocationAction = "tool" | "prompt" | "middleware" | "event";

/** Host-to-child invocation record. Functions and signals never cross this boundary. */
export interface DynamicPluginInvokeRequest {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly kind: "invoke";
	readonly invokeId: string;
	readonly capabilityId: string;
	readonly action: DynamicPluginInvocationAction;
	readonly context: DynamicPluginContext;
	readonly payload: Record<string, unknown>;
}

export interface DynamicPluginCancelRequest {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly kind: "cancel";
	readonly invokeId: string;
}

export interface DynamicPluginInvokeResult {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly kind: "invoke_result";
	readonly invokeId: string;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

export interface DynamicPluginMiddlewareNextRequest {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly kind: "middleware_next";
	readonly invokeId: string;
	readonly nextId: string;
	readonly execution: Record<string, unknown>;
}

export interface DynamicPluginMiddlewareNextResult {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly kind: "middleware_next_result";
	readonly nextId: string;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

export type DynamicPluginHostRequest = DynamicPluginInvokeRequest | DynamicPluginCancelRequest;
export type DynamicPluginChildInvocationRecord =
	| DynamicPluginInvokeResult
	| DynamicPluginMiddlewareNextRequest
	| DynamicPluginMiddlewareNextResult;

export function parseDynamicPluginChildInvocationRecord(value: unknown): DynamicPluginChildInvocationRecord {
	const record = object(value, "dynamic plugin invocation record");
	if (record.version !== DYNAMIC_PLUGIN_PROTOCOL_VERSION || typeof record.kind !== "string")
		throw new Error("invalid dynamic plugin invocation record");
	if (record.kind === "invoke_result") {
		const invokeId = boundedString(record.invokeId, "invokeId", 128);
		if (record.ok !== true && record.ok !== false) throw new Error("invoke result ok must be a boolean");
		return record.ok
			? { version: 1, kind: "invoke_result", invokeId, ok: true, result: record.result }
			: { version: 1, kind: "invoke_result", invokeId, ok: false, error: boundedString(record.error, "error", 500) };
	}
	if (record.kind === "middleware_next") {
		return {
			version: 1,
			kind: "middleware_next",
			invokeId: boundedString(record.invokeId, "invokeId", 128),
			nextId: boundedString(record.nextId, "nextId", 128),
			execution: object(record.execution, "execution"),
		};
	}
	if (record.kind === "middleware_next_result") {
		if (record.ok !== true && record.ok !== false) throw new Error("middleware next result ok must be a boolean");
		return record.ok
			? {
					version: 1,
					kind: "middleware_next_result",
					nextId: boundedString(record.nextId, "nextId", 128),
					ok: true,
					result: record.result,
				}
			: {
					version: 1,
					kind: "middleware_next_result",
					nextId: boundedString(record.nextId, "nextId", 128),
					ok: false,
					error: boundedString(record.error, "error", 500),
				};
	}
	throw new Error("unsupported dynamic plugin invocation record");
}
export interface DynamicPluginCapabilityRegister {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly id: string;
	readonly method: "capability_register";
	readonly params: { readonly runId: string; readonly pluginId: string; readonly capability: DynamicPluginCapability };
}
export interface DynamicPluginCapabilityRevoke {
	readonly version: typeof DYNAMIC_PLUGIN_PROTOCOL_VERSION;
	readonly id: string;
	readonly method: "capability_revoke";
	readonly params: { readonly runId: string; readonly pluginId: string; readonly capabilityId: string };
}
export type DynamicPluginCapabilityRecord = DynamicPluginCapabilityRegister | DynamicPluginCapabilityRevoke;

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
	private readonly _capabilities = new Map<string, DynamicPluginCapability>();
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
		this._capabilities.clear();
	}

	fail(reason: string, now = Date.now()): void {
		if (this._state === "stopped" || this._state === "failed") return;
		nonEmpty(reason, "run failure");
		this.transition(["starting", "active", "stopping"], "failed");
		this._failure = redact(reason).slice(0, 500);
		this._stoppedAt = now;
		this._capabilities.clear();
	}

	registerCapability(capability: DynamicPluginCapability): void {
		if (this._state !== "starting" && this._state !== "active")
			throw new Error(`Cannot register capability while run is ${this._state}`);
		validateCapability(capability, this.pluginId);
		if (this._capabilities.has(capability.id)) throw new Error(`Capability already registered: ${capability.id}`);
		this._capabilities.set(capability.id, capability);
	}

	revokeCapability(capabilityId: string): void {
		boundedString(capabilityId, "capabilityId", 128);
		if (!this._capabilities.delete(capabilityId)) throw new Error(`Unknown capability: ${capabilityId}`);
	}

	clearCapabilities(): void {
		this._capabilities.clear();
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
			capabilities: [...this._capabilities.values()].map((capability) => cloneCapability(capability)),
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

	registerCapability(runId: string, capability: DynamicPluginCapability): ActiveRun {
		const run = this.requireRun(runId);
		run.registerCapability(capability);
		return run;
	}

	revokeCapability(runId: string, capabilityId: string): ActiveRun {
		const run = this.requireRun(runId);
		run.revokeCapability(capabilityId);
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
export type DynamicPluginRecord = DynamicPluginRpcRequest | DynamicPluginRpcResponse | DynamicPluginCapabilityRecord;

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

export function stringifyDynamicPluginJsonl(record: DynamicPluginRecord): string {
	const value = record as Record<string, unknown>;
	if (value.version !== DYNAMIC_PLUGIN_PROTOCOL_VERSION || typeof value.id !== "string")
		throw new Error("invalid dynamic plugin record");
	if ("method" in value) {
		if (value.method === "capability_register" || value.method === "capability_revoke")
			parseDynamicPluginCapabilityRecord(record);
		else parseDynamicPluginRequest(record as DynamicPluginRpcRequest);
	} else validateDynamicPluginResponse(record as DynamicPluginRpcResponse);
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

export function parseDynamicPluginRecord(value: unknown): DynamicPluginRecord {
	const record = object(value, "dynamic plugin record");
	if ("method" in record) {
		if (record.method === "capability_register" || record.method === "capability_revoke")
			return parseDynamicPluginCapabilityRecord(record);
		return parseDynamicPluginRequest(record);
	}
	if ("ok" in record) return parseDynamicPluginResponse(record);
	throw new Error("dynamic plugin record must be a request or response");
}

export function parseDynamicPluginJsonlRecord(line: string): DynamicPluginRecord {
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

/** Parses a capability registration/revocation emitted by a dynamic child process. */
export function parseDynamicPluginCapabilityRecord(value: unknown): DynamicPluginCapabilityRecord {
	const record = object(value, "dynamic plugin capability record");
	if (record.version !== DYNAMIC_PLUGIN_PROTOCOL_VERSION)
		throw new Error("unsupported dynamic plugin protocol version");
	const id = boundedString(record.id, "capability request id", 128);
	const params = object(record.params, "capability request params");
	const runId = boundedString(params.runId, "runId", 128);
	const pluginId = boundedString(params.pluginId, "pluginId", 64);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) throw new Error("pluginId must use lowercase hyphenated form");
	if (record.method === "capability_revoke") {
		return {
			version: 1,
			id,
			method: record.method,
			params: { runId, pluginId, capabilityId: boundedString(params.capabilityId, "capabilityId", 128) },
		};
	}
	if (record.method !== "capability_register") throw new Error("unsupported dynamic plugin capability method");
	return {
		version: 1,
		id,
		method: record.method,
		params: { runId, pluginId, capability: parseCapability(params.capability, pluginId) },
	};
}

export function parseDynamicPluginCapabilityJsonl(line: string): DynamicPluginCapabilityRecord {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > DYNAMIC_PLUGIN_MAX_LINE_BYTES)
		throw new Error("dynamic plugin JSONL line exceeds size limit");
	try {
		return parseDynamicPluginCapabilityRecord(JSON.parse(line) as unknown);
	} catch (cause) {
		throw new Error(
			`invalid dynamic plugin capability JSONL: ${redact(cause instanceof Error ? cause.message : String(cause))}`,
			{
				cause,
			},
		);
	}
}

export function stringifyDynamicPluginCapabilityJsonl(record: DynamicPluginCapabilityRecord): string {
	const parsed = parseDynamicPluginCapabilityRecord(record);
	const line = JSON.stringify(parsed);
	if (Buffer.byteLength(line, "utf8") + 1 > DYNAMIC_PLUGIN_MAX_LINE_BYTES)
		throw new Error("dynamic plugin JSONL line exceeds size limit");
	return `${line}\n`;
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

function parseCapability(value: unknown, pluginId: string): DynamicPluginCapability {
	const record = object(value, "capability");
	const type = record.type;
	const id = boundedString(record.id, "capability.id", 128);
	if (type === "tool") {
		const name = boundedString(record.name, "capability.name", 128);
		if (!name.startsWith(`${pluginId}__`)) throw new Error(`dynamic tool must use ${pluginId}__ namespace`);
		const description = boundedString(record.description, "capability.description", 2_000);
		const parameters = object(record.parameters, "capability.parameters");
		if (parameters.type !== "object") throw new Error("dynamic tool parameters schema must have type object");
		if (Buffer.byteLength(JSON.stringify(parameters), "utf8") > DYNAMIC_PLUGIN_MAX_CAPABILITY_BYTES)
			throw new Error("dynamic capability schema exceeds size limit");
		return { type, id, name, description, parameters: cloneRecord(parameters) };
	}
	if (type === "prompt") {
		const order = record.order;
		if (typeof order !== "number" || !Number.isFinite(order) || Math.abs(order) > 1_000_000)
			throw new Error("dynamic prompt order must be finite");
		return { type, id, order };
	}
	if (type === "middleware") return { type, id };
	if (type === "event") return { type, id, event: boundedString(record.event, "capability.event", 128) };
	throw new Error("unsupported dynamic capability type");
}

function validateCapability(capability: DynamicPluginCapability, pluginId: string): void {
	parseCapability(capability, pluginId);
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function cloneCapability(capability: DynamicPluginCapability): DynamicPluginCapability {
	return capability.type === "tool"
		? { ...capability, parameters: cloneRecord(capability.parameters) }
		: { ...capability };
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
