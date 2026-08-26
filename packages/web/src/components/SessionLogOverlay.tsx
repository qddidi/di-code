import { X } from "lucide-react";
import type { SessionSummary, UsageSnapshot } from "../types.ts";
import { IconButton } from "./IconButton.tsx";

interface SessionLogOverlayProps {
	readonly open: boolean;
	readonly session?: SessionSummary;
	readonly usage?: UsageSnapshot;
	readonly onClose: () => void;
}

export function SessionLogOverlay({ open, session, usage, onClose }: SessionLogOverlayProps): React.JSX.Element | null {
	if (!open) return null;
	return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="session-log-panel" role="dialog" aria-modal="true" aria-labelledby="session-log-title"><header><div><p className="eyebrow">Current session</p><h2 id="session-log-title">Session log</h2></div><IconButton label="Close session log" icon={X} onClick={onClose} /></header><dl><div><dt>Messages</dt><dd>{session?.stats?.messageCount ?? 0}</dd></div><div><dt>Entries</dt><dd>{session?.stats?.entryCount ?? 0}</dd></div><div><dt>Requests</dt><dd>{usage?.requestCount ?? 0}</dd></div><div><dt>Cumulative input tokens</dt><dd>{usage?.inputTokens ?? 0}</dd></div><div><dt>Cumulative output tokens</dt><dd>{usage?.outputTokens ?? 0}</dd></div></dl></section></div>;
}
