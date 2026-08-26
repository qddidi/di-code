import { ChevronDown, MessageSquarePlus, PanelLeftClose, Settings, Sparkles } from "lucide-react";
import type { SessionSummary } from "../types.ts";
import { IconButton } from "./IconButton.tsx";
import { SessionTree } from "./SessionTree.tsx";

interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly collapsed: boolean;
	readonly onToggle: () => void;
	readonly onNewSession: () => void;
	readonly activeSessionId?: string;
	readonly onOpenSession: (id: string) => void;
	readonly onSettings: () => void;
	readonly onRenameSession: (id: string, label: string) => Promise<void>;
	readonly onDeleteSession: (id: string) => Promise<void>;
	readonly onBranchSession: (id: string) => Promise<void>;
	readonly onInspectSession: (id: string) => Promise<unknown>;
	readonly webSlot?: React.ReactNode;
	readonly sessionWebSlot?: React.ReactNode;
}

export function Sidebar({ sessions, collapsed, onToggle, onNewSession, onSettings, activeSessionId, onOpenSession, onRenameSession, onDeleteSession, onBranchSession, onInspectSession, webSlot, sessionWebSlot }: SidebarProps): React.JSX.Element {
	return (
		<aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Workspace navigation">
			<div className="sidebar-topline">
				<div className="mark" aria-label="di-code"><Sparkles size={17} /></div>
				{!collapsed ? <span className="wordmark">di-code</span> : null}
				<IconButton label={collapsed ? "Open sidebar" : "Collapse sidebar"} icon={PanelLeftClose} onClick={onToggle} />
			</div>
			{!collapsed ? (
				<>
					<div className="workspace-switcher"><span className="workspace-avatar">W</span><span className="workspace-name">Workspace</span><ChevronDown size={16} /></div>
					<button className="new-session" type="button" onClick={onNewSession}><MessageSquarePlus size={17} />New session<span className="shortcut">⌘ K</span></button>
					<div className="session-heading"><span>Sessions</span><span className="session-count">{sessions.length}</span></div>
					<SessionTree sessions={sessions} activeSessionId={activeSessionId} onOpen={onOpenSession} onRename={onRenameSession} onDelete={onDeleteSession} onBranch={onBranchSession} onInspect={onInspectSession} />
					{sessionWebSlot ? <div className="web-slot-session-tree">{sessionWebSlot}</div> : null}
					{webSlot ? <div className="web-slot-sidebar">{webSlot}</div> : null}
					<div className="sidebar-footer"><button className="footer-button" type="button" onClick={onSettings}><Settings size={17} />Settings</button></div>
				</>
			) : <div className="collapsed-actions"><IconButton label="New session" icon={MessageSquarePlus} onClick={onNewSession} /><IconButton label="Settings" icon={Settings} onClick={onSettings} /></div>}
		</aside>
	);
}
