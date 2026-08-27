import { ChevronDown, MessageSquarePlus, PanelLeftClose, Settings, Sparkles } from "lucide-react";
import type { SessionSummary, WorkspaceSummary } from "../types.ts";
import { IconButton } from "./IconButton.tsx";
import { SessionTree } from "./SessionTree.tsx";
import { useI18n } from "../i18n.tsx";

interface SidebarProps {
	readonly sessions: readonly SessionSummary[];
	readonly workspaces: readonly WorkspaceSummary[];
	readonly activeWorkspaceId?: string;
	readonly onSelectWorkspace: (id: string) => void;
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

export function Sidebar({ sessions, workspaces, activeWorkspaceId, onSelectWorkspace, collapsed, onToggle, onNewSession, onSettings, activeSessionId, onOpenSession, onRenameSession, onDeleteSession, onBranchSession, onInspectSession, webSlot, sessionWebSlot }: SidebarProps): React.JSX.Element {
	const { t } = useI18n();
	return (
		<aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label={t("Workspace navigation")}>
			<div className="sidebar-topline">
				<div className="mark" aria-label="di-code"><Sparkles size={17} /></div>
				{!collapsed ? <span className="wordmark">di-code</span> : null}
				<IconButton label={collapsed ? t("Open sidebar") : t("Collapse sidebar")} icon={PanelLeftClose} onClick={onToggle} />
			</div>
			{!collapsed ? (
				<>
					<label className="workspace-switcher"><span className="workspace-avatar">W</span><select aria-label={t("Select workspace")} className="workspace-name" value={activeWorkspaceId} onChange={(event) => onSelectWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><ChevronDown size={16} aria-hidden="true" /></label>
					<button className="new-session" type="button" onClick={onNewSession}><MessageSquarePlus size={17} />{t("New session")}<span className="shortcut">⌘ K</span></button>
					<div className="session-heading"><span>{t("Sessions")}</span><span className="session-count">{sessions.length}</span></div>
					<SessionTree sessions={sessions} activeSessionId={activeSessionId} onOpen={onOpenSession} onRename={onRenameSession} onDelete={onDeleteSession} onBranch={onBranchSession} onInspect={onInspectSession} />
					{sessionWebSlot ? <div className="web-slot-session-tree">{sessionWebSlot}</div> : null}
					{webSlot ? <div className="web-slot-sidebar">{webSlot}</div> : null}
					<div className="sidebar-footer"><button className="footer-button" type="button" onClick={onSettings}><Settings size={17} />{t("Settings")}</button></div>
				</>
			) : <div className="collapsed-actions"><IconButton label={t("New session")} icon={MessageSquarePlus} onClick={onNewSession} /><IconButton label={t("Settings")} icon={Settings} onClick={onSettings} /></div>}
		</aside>
	);
}
