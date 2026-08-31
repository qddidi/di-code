import type { Component, TUI } from "./tui.ts";

export interface CustomUiRequest {
	readonly title: string;
	readonly body: unknown;
	readonly component?: Component;
}

export interface CustomUiResult {
	readonly version: 1;
	readonly closed: boolean;
	readonly reason: "submitted" | "cancelled" | "disposed";
	readonly value?: unknown;
}

/** Bridges extension custom UI to TUI overlays while keeping child cancellation separate. */
export function createTuiCustomUi(tui: TUI, options: { readonly isTty?: boolean } = {}) {
	return {
		custom: async (request: CustomUiRequest, signal?: AbortSignal): Promise<CustomUiResult> => {
			if (options.isTty === false)
				throw Object.assign(new Error("UI is unavailable without a TTY"), { code: "UI_UNAVAILABLE" });
			if (!request.component) return { version: 1, closed: true, reason: "submitted", value: request.body };
			let resolveResult: (result: CustomUiResult) => void = () => undefined;
			const result = new Promise<CustomUiResult>((resolve) => {
				resolveResult = resolve;
			});
			const overlay = tui.showOverlay(request.component);
			const close = (reason: CustomUiResult["reason"]): void => {
				overlay.hide();
				resolveResult({ version: 1, closed: true, reason });
			};
			if (signal) signal.addEventListener("abort", () => close("cancelled"), { once: true });
			return result;
		},
	};
}
