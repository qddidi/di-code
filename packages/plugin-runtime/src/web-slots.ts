import type { Disposer, RegistryOwner } from "./index.ts";

/** Stable Web extension slots. Unknown values are intentionally forward-compatible. */
export type WebSlotId = "app.sidebar" | "session.tree" | "conversation.node" | "conversation.tool" | "settings.panel";

export const WEB_EXTENSION_PROTOCOL_VERSION = 1 as const;
export const WEB_SLOT_IDS: readonly WebSlotId[] = [
	"app.sidebar",
	"session.tree",
	"conversation.node",
	"conversation.tool",
	"settings.panel",
];

export interface WebContribution {
	readonly id: string;
	readonly slot: WebSlotId | (string & {});
	readonly version: typeof WEB_EXTENSION_PROTOCOL_VERSION;
	readonly order?: number;
	/** Capability required by the host before this contribution is exposed. */
	readonly capability?: "ui" | "session.read" | "conversation.read" | "settings.read";
	/** Host-owned component key. It is never an import URL or executable source. */
	readonly componentKey: string;
	/** JSON-like, read-only data passed to the host component. */
	readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WebBundleDeclaration {
	readonly source: "builtin" | "managed";
	readonly path?: string;
	readonly sha256?: string;
	readonly csp?: string;
}

export interface WebManifest {
	readonly protocolVersion: typeof WEB_EXTENSION_PROTOCOL_VERSION;
	readonly bundle?: WebBundleDeclaration;
	readonly contributions: readonly WebContribution[];
}

export type WebSlotContribution = WebContribution & {
	readonly owner: RegistryOwner;
};

export class WebSlotRegistryError extends Error {
	readonly code: "invalid" | "duplicate" | "capability";
	constructor(code: WebSlotRegistryError["code"], message: string) {
		super(message);
		this.name = "WebSlotRegistryError";
		this.code = code;
	}
}

const identifier = /^[a-z0-9][a-z0-9._-]*$/u;
const knownSlots = new Set<string>(WEB_SLOT_IDS);

export function isWebSlotId(value: string): value is WebSlotId {
	return knownSlots.has(value);
}

export function validateWebContribution(value: unknown): value is WebContribution {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		!identifier.test(record.id) ||
		typeof record.slot !== "string" ||
		typeof record.componentKey !== "string" ||
		!identifier.test(record.componentKey) ||
		record.version !== WEB_EXTENSION_PROTOCOL_VERSION
	)
		return false;
	if (record.order !== undefined && (!Number.isSafeInteger(record.order) || (record.order as number) < -1_000_000))
		return false;
	if (
		record.capability !== undefined &&
		record.capability !== "ui" &&
		record.capability !== "session.read" &&
		record.capability !== "conversation.read" &&
		record.capability !== "settings.read"
	)
		return false;
	if (record.data !== undefined) {
		if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) return false;
		for (const item of Object.values(record.data as Record<string, unknown>))
			if (!(item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
				return false;
	}
	return true;
}

export function assertWebContribution(value: unknown): asserts value is WebContribution {
	if (!validateWebContribution(value)) throw new WebSlotRegistryError("invalid", "Web contribution is invalid.");
}

export function validateWebManifest(value: unknown): value is WebManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.protocolVersion !== WEB_EXTENSION_PROTOCOL_VERSION || !Array.isArray(record.contributions)) return false;
	if (!record.contributions.every(validateWebContribution)) return false;
	if (record.bundle !== undefined) {
		if (typeof record.bundle !== "object" || record.bundle === null || Array.isArray(record.bundle)) return false;
		const bundle = record.bundle as Record<string, unknown>;
		if (bundle.source !== "builtin" && bundle.source !== "managed") return false;
		if (
			bundle.path !== undefined &&
			(typeof bundle.path !== "string" || bundle.path.includes("..") || bundle.path.startsWith("/"))
		)
			return false;
		if (bundle.sha256 !== undefined && (typeof bundle.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(bundle.sha256)))
			return false;
		if (bundle.csp !== undefined && (typeof bundle.csp !== "string" || !bundle.csp.includes("default-src")))
			return false;
	}
	return true;
}

/** Owner-aware Web registry. Unknown slots are ignored for old clients. */
export class WebSlotRegistry {
	private readonly entries = new Map<string, WebSlotContribution>();
	private sequence = 0;
	register(
		value: WebContribution,
		owner: RegistryOwner,
		capabilities: ReadonlySet<string> = new Set(["ui"]),
	): Disposer {
		assertWebContribution(value);
		if (!isWebSlotId(value.slot)) return () => undefined;
		if (value.capability && !capabilities.has(value.capability))
			throw new WebSlotRegistryError("capability", `Web contribution capability denied: ${value.capability}`);
		const key = value.id;
		if (this.entries.has(key)) throw new WebSlotRegistryError("duplicate", `Duplicate Web contribution: ${key}`);
		const entry = Object.freeze({ ...value, owner, _sequence: this.sequence++ }) as WebSlotContribution;
		this.entries.set(key, entry);
		let active = true;
		const dispose: Disposer = () => {
			if (!active) return;
			active = false;
			if (this.entries.get(key) === entry) this.entries.delete(key);
		};
		if (owner.fiber) {
			try {
				owner.fiber.addDisposer(dispose);
			} catch (error) {
				dispose();
				throw error;
			}
		}
		return dispose;
	}
	list(slot: WebSlotId): readonly WebSlotContribution[] {
		return Object.freeze(
			[...this.entries.values()]
				.filter((entry) => entry.slot === slot)
				.sort(
					(left, right) =>
						(left.order ?? 0) - (right.order ?? 0) ||
						(left as WebSlotContribution & { _sequence: number })._sequence -
							(right as WebSlotContribution & { _sequence: number })._sequence,
				),
		);
	}
	snapshot(): readonly WebSlotContribution[] {
		return Object.freeze([...this.entries.values()]);
	}
	dispose(): void {
		this.entries.clear();
	}
}
