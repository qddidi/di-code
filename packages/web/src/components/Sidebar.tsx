import { ChevronDown, Folder, MessageSquarePlus, PanelLeftClose, Search, Settings, Sparkles } from "lucide-react";
import type { SessionSummary } from "../types.ts";
import { IconButton } from "./IconButton.tsx";

interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly collapsed: boolean;
	readonly onToggle: () => void;
	readonly onNewSession: () => void;
	readonly onSettings: () => void;
}

export function Sidebar({ sessions, collapsed, onToggle, onNewSession, onSettings }: SidebarProps): React.JSX.Element {
	return (
		<aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Workspace navigation">
			<div className="sidebar-topline">
				<div className="mark" aria-label="di-code"><Sparkles size={17} /></div>
				{!collapsed ? <span className="wordmark">di-code</span> : null}
				<IconButton label={collapsed ? "Open sidebar" : "Collapse sidebar"} icon={PanelLeftClose} onClick={onToggle} />
			</div>
			{!collapsed ? (
				<>
					<button className="workspace-switcher" type="button"><span className="workspace-avatar">W</span><span className="workspace-name">Workspace</span><ChevronDown size={16} /></button>
					<button className="new-session" type="button" onClick={onNewSession}><MessageSquarePlus size={17} />New session<span className="shortcut">⌘ K</span></button>
					<label className="session-search"><Search size={16} /><input aria-label="Search sessions" placeholder="Search sessions" /></label>
					<div className="session-heading"><span>Sessions</span><span className="session-count">{sessions.length}</span></div>
					<div className="session-tree" role="list" aria-label="Sessions">
						{sessions.length === 0 ? <p className="tree-placeholder">Your sessions will appear here.</p> : sessions.map((session) => <button className="session-item" key={session.id} type="button"><MessageSquarePlus size={15} /><span>{session.label || "Untitled session"}</span></button>)}
					</div>
					<div className="sidebar-footer"><button className="footer-button" type="button" onClick={onSettings}><Settings size={17} />Settings</button><button className="footer-button" type="button"><Folder size={17} />Workspace files</button></div>
				</>
			) : <div className="collapsed-actions"><IconButton label="New session" icon={MessageSquarePlus} onClick={onNewSession} /><IconButton label="Settings" icon={Settings} onClick={onSettings} /></div>}
		</aside>
	);
}
