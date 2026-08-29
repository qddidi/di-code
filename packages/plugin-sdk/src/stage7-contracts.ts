import type { Disposer, WebSlotId } from "@di-code/plugin-runtime";

export const EXTENSION_FACADE_API_VERSION = 1 as const;
export type ExtensionSurface = "badge" | "control" | "review" | "placeholder";
export interface ExtensionStateBadge {
	readonly id: string;
	readonly label: string;
	readonly tone: "neutral" | "info" | "success" | "warning" | "error";
	readonly busy?: boolean;
}
export interface ExtensionUiContribution {
	readonly id: string;
	readonly surface: ExtensionSurface;
	readonly slot: WebSlotId | (string & {});
	readonly version: typeof EXTENSION_FACADE_API_VERSION;
	readonly componentKey: string;
	readonly data: Readonly<Record<string, string | number | boolean | null>>;
}
export interface SessionExtensionFacade {
	readonly apiVersion: typeof EXTENSION_FACADE_API_VERSION;
	readonly sessionId?: string;
	readonly badges: readonly ExtensionStateBadge[];
	readonly ui: readonly ExtensionUiContribution[];
	readonly subscribe: (listener: (snapshot: SessionExtensionFacade) => void) => Disposer;
}

/** Mutable owner-side registry used to build a session extension facade. */
export interface SessionExtensionRegistry extends SessionExtensionFacade {
	readonly registerBadge: (badge: ExtensionStateBadge) => Disposer;
	readonly registerUi: (contribution: ExtensionUiContribution) => Disposer;
	readonly clear: () => void;
}

function assertId(value: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/.test(value)) throw new TypeError(`${label} is invalid.`);
}

function snapshot(registry: SessionExtensionRegistry): SessionExtensionFacade {
	return Object.freeze({
		apiVersion: EXTENSION_FACADE_API_VERSION,
		...(registry.sessionId ? { sessionId: registry.sessionId } : {}),
		badges: Object.freeze(registry.badges.map((badge) => Object.freeze({ ...badge }))),
		ui: Object.freeze(registry.ui.map((item) => Object.freeze({ ...item, data: Object.freeze({ ...item.data }) }))),
		subscribe: registry.subscribe,
	});
}

/** Creates a validated, observable registry for one Session's declarative UI surface. */
export function createSessionExtensionRegistry(sessionId?: string): SessionExtensionRegistry {
	if (sessionId !== undefined) assertId(sessionId, "Session extension sessionId");
	const badges: ExtensionStateBadge[] = [];
	const ui: ExtensionUiContribution[] = [];
	const listeners = new Set<(snapshot: SessionExtensionFacade) => void>();
	const registry = {
		apiVersion: EXTENSION_FACADE_API_VERSION,
		...(sessionId ? { sessionId } : {}),
		badges,
		ui,
		subscribe(listener: (value: SessionExtensionFacade) => void): Disposer {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		registerBadge(badge: ExtensionStateBadge): Disposer {
			assertId(badge.id, "Extension badge id");
			if (typeof badge.label !== "string" || badge.label.trim() === "")
				throw new TypeError("Extension badge label is required.");
			if (badges.some((item) => item.id === badge.id)) throw new Error(`Duplicate extension badge: ${badge.id}`);
			badges.push({ ...badge });
			for (const listener of listeners) listener(snapshot(registry));
			return () => {
				const index = badges.findIndex((item) => item.id === badge.id);
				if (index >= 0) {
					badges.splice(index, 1);
					for (const listener of listeners) listener(snapshot(registry));
				}
			};
		},
		registerUi(contribution: ExtensionUiContribution): Disposer {
			assertId(contribution.id, "Extension UI id");
			if (contribution.version !== EXTENSION_FACADE_API_VERSION)
				throw new TypeError("Unsupported extension UI version.");
			if (typeof contribution.componentKey !== "string" || contribution.componentKey.includes("/"))
				throw new TypeError("Extension componentKey must be a host whitelist key.");
			if (ui.some((item) => item.id === contribution.id)) throw new Error(`Duplicate extension UI: ${contribution.id}`);
			ui.push({ ...contribution, data: { ...contribution.data } });
			for (const listener of listeners) listener(snapshot(registry));
			return () => {
				const index = ui.findIndex((item) => item.id === contribution.id);
				if (index >= 0) {
					ui.splice(index, 1);
					for (const listener of listeners) listener(snapshot(registry));
				}
			};
		},
		clear(): void {
			badges.length = 0;
			ui.length = 0;
			for (const listener of listeners) listener(snapshot(registry));
		},
	} satisfies SessionExtensionRegistry;
	return registry;
}
