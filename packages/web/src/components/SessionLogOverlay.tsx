import { X } from "lucide-react";
import type { SessionSummary, UsageSnapshot } from "../types.ts";
import { IconButton } from "./IconButton.tsx";
import { useI18n } from "../i18n.tsx";

interface SessionLogOverlayProps {
	readonly open: boolean;
	readonly session?: SessionSummary;
	readonly usage?: UsageSnapshot;
	readonly onClose: () => void;
}

export function SessionLogOverlay({ open, session, usage, onClose }: SessionLogOverlayProps): React.JSX.Element | null {
	const { t } = useI18n();
	if (!open) return null;
	return <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="session-log-panel" role="dialog" aria-modal="true" aria-labelledby="session-log-title"><header><div><p className="eyebrow">{t("Current session")}</p><h2 id="session-log-title">{t("Session log")}</h2></div><IconButton label={t("Close session log")} icon={X} onClick={onClose} /></header><dl><div><dt>{t("Messages")}</dt><dd>{session?.stats?.messageCount ?? 0}</dd></div><div><dt>{t("Entries")}</dt><dd>{session?.stats?.entryCount ?? 0}</dd></div><div><dt>{t("Requests")}</dt><dd>{usage?.requestCount ?? 0}</dd></div><div><dt>{t("Cumulative input tokens")}</dt><dd>{usage?.inputTokens ?? 0}</dd></div><div><dt>{t("Cumulative output tokens")}</dt><dd>{usage?.outputTokens ?? 0}</dd></div></dl></section></div>;
}
