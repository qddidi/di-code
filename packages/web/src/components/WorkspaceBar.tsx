import { ChevronDown, Ellipsis, PanelLeft, Plus, Settings2 } from "lucide-react";
import { IconButton } from "./IconButton.tsx";

interface WorkspaceBarProps { readonly onToggleSidebar: () => void; readonly onSettings: () => void; }

export function WorkspaceBar({ onToggleSidebar, onSettings }: WorkspaceBarProps): React.JSX.Element {
	return <header className="workspace-bar"><IconButton label="Open navigation" icon={PanelLeft} onClick={onToggleSidebar} /><div className="bar-title"><span className="bar-title-dot" />Workspace<ChevronDown size={15} /></div><div className="bar-actions"><button type="button" className="bar-action"><Plus size={16} />Invite</button><IconButton label="Workspace options" icon={Ellipsis} /><IconButton label="Settings" icon={Settings2} onClick={onSettings} /></div></header>;
}
