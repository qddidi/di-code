import { PanelLeft, Settings2 } from "lucide-react";
import { IconButton } from "./IconButton.tsx";
import { useI18n } from "../i18n.tsx";

interface WorkspaceBarProps { readonly onToggleSidebar: () => void; readonly onSettings: () => void; readonly onSessionLog: () => void; readonly title?: string; }

export function WorkspaceBar({ onToggleSidebar, onSettings, onSessionLog, title }: WorkspaceBarProps): React.JSX.Element {
	const { t } = useI18n();
	return <header className="workspace-bar"><IconButton label={t("Open navigation")} icon={PanelLeft} onClick={onToggleSidebar} /><div className="bar-title"><span className="bar-session-title">{title ?? t("Session")}</span><span className="bar-mode"><span className="bar-title-dot" />{t("Standard mode")}</span></div><div className="bar-actions"><button type="button" className="bar-action session-log" onClick={onSessionLog}>{t("Session log")}</button><IconButton label={t("Settings")} icon={Settings2} onClick={onSettings} /></div></header>;
}
