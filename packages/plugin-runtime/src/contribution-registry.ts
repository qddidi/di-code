import type { Disposer, RegistryOwner } from "./index.ts";

export type ContributionKind =
	| "provider"
	| "tool"
	| "command"
	| "prompt"
	| "session-store"
	| "session-factory"
	| "compaction"
	| "renderer"
	| "rpc-method"
	| "resource";

export interface ProviderModel {
	readonly id: string;
	readonly name?: string;
	readonly input?: readonly ("text" | "image")[];
	readonly reasoning?: boolean;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}
export interface ProviderContribution {
	readonly kind: "provider";
	readonly name: string;
	readonly namespace?: string;
	readonly models: readonly ProviderModel[];
	readonly stream?: (model: ProviderModel, input: unknown, signal?: AbortSignal) => AsyncIterable<unknown>;
}
export interface ToolSchema {
	readonly type: "object";
	readonly properties?: Readonly<Record<string, unknown>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | Readonly<Record<string, unknown>>;
}
export interface ToolContribution {
	readonly kind: "tool";
	readonly name: string;
	readonly namespace?: string;
	readonly description?: string;
	readonly schema: ToolSchema;
	readonly execute: (input: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
}
export interface CommandContribution {
	readonly kind: "command";
	readonly name: string;
	readonly namespace?: string;
	readonly description?: string;
	readonly run: (input: string, signal?: AbortSignal) => unknown | Promise<unknown>;
}
export interface PromptContribution {
	readonly kind: "prompt";
	readonly name: string;
	readonly namespace?: string;
	readonly get: (input?: unknown, signal?: AbortSignal) => string | Promise<string>;
}
export interface SessionStoreContribution {
	readonly kind: "session-store";
	readonly name: string;
	readonly namespace?: string;
	readonly store: unknown;
}
export interface SessionFactoryContribution {
	readonly kind: "session-factory";
	readonly name: string;
	readonly namespace?: string;
	readonly create: (input: unknown) => unknown | Promise<unknown>;
}
export interface CompactionContribution {
	readonly kind: "compaction";
	readonly name: string;
	readonly namespace?: string;
	readonly compact: (input: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
}
export interface RendererContribution {
	readonly kind: "renderer";
	readonly name: string;
	readonly namespace?: string;
	readonly render: (input: unknown) => string;
}
export interface RpcMethodContribution {
	readonly kind: "rpc-method";
	readonly name: string;
	readonly namespace?: string;
	readonly params?: ToolSchema;
	readonly handle: (params: unknown, signal?: AbortSignal) => unknown | Promise<unknown>;
}
export interface ResourceContribution {
	readonly kind: "resource";
	readonly name: string;
	readonly namespace?: string;
	readonly uri: string;
	readonly read: (signal?: AbortSignal) => unknown | Promise<unknown>;
}
export type Contribution =
	| ProviderContribution
	| ToolContribution
	| CommandContribution
	| PromptContribution
	| SessionStoreContribution
	| SessionFactoryContribution
	| CompactionContribution
	| RendererContribution
	| RpcMethodContribution
	| ResourceContribution;
export interface ContributionEntry<T extends Contribution = Contribution> {
	readonly kind: T["kind"];
	readonly name: string;
	readonly namespace?: string;
	readonly value: T;
	readonly owner: RegistryOwner;
}
export interface ContributionSnapshot {
	readonly entries: readonly ContributionEntry[];
}
export interface ContributionRegistryOptions {
	readonly reserved?: readonly string[];
}
export class ContributionRegistryError extends Error {
	readonly code: "invalid" | "duplicate" | "reserved" | "namespace-conflict";
	constructor(code: ContributionRegistryError["code"], message: string) {
		super(message);
		this.name = "ContributionRegistryError";
		this.code = code;
	}
}

const kindOrder: readonly ContributionKind[] = [
	"provider",
	"tool",
	"command",
	"prompt",
	"session-store",
	"session-factory",
	"compaction",
	"renderer",
	"rpc-method",
	"resource",
];
const namePattern = /^[a-z0-9][a-z0-9._-]*$/;
function qualifiedName(namespace: string | undefined, name: string): string {
	return namespace ? `${namespace}:${name}` : name;
}
function validateIdentifier(value: string, label: string): void {
	if (!namePattern.test(value))
		throw new ContributionRegistryError("invalid", `${label} must match ${namePattern.source}`);
}
function validSchema(value: unknown): value is ToolSchema {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.type !== "object") return false;
	if (
		record.properties !== undefined &&
		(typeof record.properties !== "object" || record.properties === null || Array.isArray(record.properties))
	)
		return false;
	if (
		record.required !== undefined &&
		(!Array.isArray(record.required) || !record.required.every((item) => typeof item === "string"))
	)
		return false;
	if (
		record.additionalProperties !== undefined &&
		typeof record.additionalProperties !== "boolean" &&
		(typeof record.additionalProperties !== "object" ||
			record.additionalProperties === null ||
			Array.isArray(record.additionalProperties))
	)
		return false;
	return true;
}
export function isToolSchema(value: unknown): value is ToolSchema {
	return validSchema(value);
}
export function assertToolSchema(value: unknown): asserts value is ToolSchema {
	if (!validSchema(value)) throw new ContributionRegistryError("invalid", "Tool schema must be an object JSON schema");
}
export function isProviderModel(value: unknown): value is ProviderModel {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) return false;
	if (record.name !== undefined && typeof record.name !== "string") return false;
	if (
		record.input !== undefined &&
		(!Array.isArray(record.input) || !record.input.every((item) => item === "text" || item === "image"))
	)
		return false;
	if (record.reasoning !== undefined && typeof record.reasoning !== "boolean") return false;
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const number = record[key];
		if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0))
			return false;
	}
	return true;
}
export function assertProviderModel(value: unknown): asserts value is ProviderModel {
	if (!isProviderModel(value)) throw new ContributionRegistryError("invalid", "Provider model is invalid");
}
export function isRpcMethodContribution(value: unknown): value is RpcMethodContribution {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.kind === "rpc-method" &&
		typeof record.name === "string" &&
		namePattern.test(record.name) &&
		(record.namespace === undefined || (typeof record.namespace === "string" && namePattern.test(record.namespace))) &&
		(record.params === undefined || validSchema(record.params)) &&
		typeof record.handle === "function"
	);
}
export function assertRpcMethodContribution(value: unknown): asserts value is RpcMethodContribution {
	if (!isRpcMethodContribution(value))
		throw new ContributionRegistryError("invalid", "RPC method contribution is invalid");
}

export class ContributionRegistry {
	private readonly entries = new Map<string, ContributionEntry>();
	private readonly reserved: ReadonlySet<string>;
	constructor(options: ContributionRegistryOptions = {}) {
		this.reserved = new Set(options.reserved ?? []);
		for (const name of this.reserved) validateIdentifier(name, "Reserved name");
	}
	register<T extends Contribution>(value: T, owner: RegistryOwner): Disposer {
		validateIdentifier(value.name, "Contribution name");
		if (value.namespace !== undefined) validateIdentifier(value.namespace, "Contribution namespace");
		const qualified = qualifiedName(value.namespace, value.name);
		if (this.reserved.has(qualified) || this.reserved.has(value.name))
			throw new ContributionRegistryError("reserved", `Contribution name is reserved: ${qualified}`);
		if (value.kind === "tool") {
			assertToolSchema(value.schema);
			if (typeof value.execute !== "function")
				throw new ContributionRegistryError("invalid", "Tool contribution must provide an execute function");
		}
		if (value.kind === "rpc-method") assertRpcMethodContribution(value);
		if (value.kind === "provider") {
			if (!Array.isArray(value.models) || value.models.length === 0)
				throw new ContributionRegistryError("invalid", "Provider must declare models");
			for (const model of value.models) assertProviderModel(model);
		}
		const key = `${qualified}\u0000${value.kind}`;
		if (this.entries.has(key))
			throw new ContributionRegistryError("duplicate", `Duplicate contribution: ${qualified} (${value.kind})`);
		for (const entry of this.entries.values())
			if (qualifiedName(entry.namespace, entry.name) === qualified && entry.kind !== value.kind)
				throw new ContributionRegistryError("namespace-conflict", `Contribution namespace conflict: ${qualified}`);
		const entry = Object.freeze({
			kind: value.kind,
			name: value.name,
			namespace: value.namespace,
			value,
			owner,
		}) as ContributionEntry<T>;
		this.entries.set(key, entry as ContributionEntry);
		let active = true;
		const disposer: Disposer = () => {
			if (!active) return;
			active = false;
			if (this.entries.get(key) === entry) this.entries.delete(key);
		};
		if (owner.fiber) {
			try {
				owner.fiber.addDisposer(disposer);
			} catch (error) {
				disposer();
				throw error;
			}
		}
		return disposer;
	}
	list<K extends ContributionKind>(kind: K): readonly ContributionEntry<Extract<Contribution, { kind: K }>>[] {
		return Object.freeze(
			this.sorted().filter((entry) => entry.kind === kind) as unknown as readonly ContributionEntry<
				Extract<Contribution, { kind: K }>
			>[],
		);
	}
	snapshot(): ContributionSnapshot {
		return Object.freeze({ entries: Object.freeze(this.sorted()) });
	}
	private sorted(): ContributionEntry[] {
		return [...this.entries.values()].sort((a, b) => {
			const kind = kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
			return kind || qualifiedName(a.namespace, a.name).localeCompare(qualifiedName(b.namespace, b.name));
		});
	}
}
