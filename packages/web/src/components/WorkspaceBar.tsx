import { PanelLeft, Settings2 } from "lucide-react";
import { IconButton } from "./IconButton.tsx";

interface WorkspaceBarProps { readonly onToggleSidebar: () => void; readonly onSettings: () => void; readonly onSessionLog: () => void; readonly title?: string; }

export function WorkspaceBar({ onToggleSidebar, onSettings, onSessionLog, title }: WorkspaceBarProps): React.JSX.Element {
	return <header className="workspace-bar"><IconButton label="Open navigation" icon={PanelLeft} onClick={onToggleSidebar} /><div className="bar-title"><span className="bar-session-title">{title ?? "Session"}</span><span className="bar-mode"><span className="bar-title-dot" />Standard mode</span></div><div className="bar-actions"><button type="button" className="bar-action session-log" onClick={onSessionLog}>Session log</button><IconButton label="Settings" icon={Settings2} onClick={onSettings} /></div></header>;
}
