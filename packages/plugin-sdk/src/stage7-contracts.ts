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
