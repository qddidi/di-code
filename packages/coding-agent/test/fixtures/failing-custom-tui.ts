import { createUiHostEntry, type UiHost } from "@di-code/coding-agent/ui-host";

export let disposedHost: UiHost | undefined;

export const apiVersion = 1 as const;
export const name = "failing-custom-tui";
const entry = createUiHostEntry(async ({ host }) => {
	disposedHost = host;
	throw new Error("custom TUI startup failed");
});

export const apply = entry.apply;
