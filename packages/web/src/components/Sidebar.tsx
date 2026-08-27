import { ChevronDown, Folder, FolderOpen, FolderPlus, MessageSquarePlus, MoreHorizontal, PanelLeftClose, Search, Settings, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary, WorkspaceSummary } from "../types.ts";
import { IconButton } from "./IconButton.tsx";
import { SessionTree } from "./SessionTree.tsx";
import { useI18n } from "../i18n.tsx";

interface SidebarProps {
	readonly sessionsByWorkspace: Readonly<Record<string, readonly SessionSummary[]>>;
	readonly workspaces: readonly WorkspaceSummary[];
	readonly activeWorkspaceId?: string;
	readonly onSelectWorkspace: (id: string) => void;
	readonly onAddWorkspace: () => Promise<WorkspaceSummary | undefined>;
	readonly collapsed: boolean;
	readonly onToggle: () => void;
	readonly onNewSession: (workspaceId?: string) => void;
	readonly activeSessionId?: string;
	readonly onOpenSession: (workspaceId: string, sessionId: string) => void;
	readonly onSettings: () => void;
	readonly onRenameSession: (id: string, label: string) => Promise<void>;
	readonly onDeleteSession: (id: string) => Promise<void>;
	readonly onBranchSession: (id: string) => Promise<void>;
	readonly onInspectSession: (id: string) => Promise<unknown>;
	readonly webSlot?: React.ReactNode;
	readonly sessionWebSlot?: React.ReactNode;
}

export function Sidebar({ sessionsByWorkspace, workspaces, activeWorkspaceId, onSelectWorkspace, onAddWorkspace, collapsed, onToggle, onNewSession, onSettings, activeSessionId, onOpenSession, onRenameSession, onDeleteSession, onBranchSession, onInspectSession, webSlot, sessionWebSlot }: SidebarProps): React.JSX.Element {
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});
	const [addOpen, setAddOpen] = useState(false);
	const [addError, setAddError] = useState<string>();
	const [adding, setAdding] = useState(false);
	const searchInput = useRef<HTMLInputElement>(null);
	const directoryInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		directoryInput.current?.setAttribute("webkitdirectory", "");
		directoryInput.current?.setAttribute("directory", "");
	}, []);

	useEffect(() => {
		if (!activeWorkspaceId) return;
		setExpanded((current) => current[activeWorkspaceId] ? current : { ...current, [activeWorkspaceId]: true });
	}, [activeWorkspaceId]);
	useEffect(() => {
		if (searchOpen) searchInput.current?.focus();
	}, [searchOpen]);

	const visibleSessions = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return (workspaceId: string): readonly SessionSummary[] => {
			const sessions = sessionsByWorkspace[workspaceId] ?? [];
			return normalized ? sessions.filter((session) => session.label.toLowerCase().includes(normalized)) : sessions;
		};
	}, [query, sessionsByWorkspace]);
	const pickWorkspace = async (): Promise<void> => {
		if (adding) return;
		setAddError(undefined);
		setAdding(true);
		try {
			await onAddWorkspace();
			setAddOpen(false);
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === "AbortError") return;
			setAddError(cause instanceof Error ? cause.message : t("Unable to add workspace."));
		} finally {
			setAdding(false);
		}
	};

	return (
		<aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label={t("Workspace navigation")}>
			<div className="sidebar-topline">
				<div className="mark" aria-label="di-code"><Sparkles size={17} /></div>
				{!collapsed ? <span className="wordmark">di-code</span> : null}
				<IconButton label={collapsed ? t("Open sidebar") : t("Collapse sidebar")} icon={PanelLeftClose} onClick={onToggle} />
			</div>
			{!collapsed ? (
				<>
						<button className="new-session" type="button" onClick={() => onNewSession()}><MessageSquarePlus size={17} />{t("New session")}<span className="shortcut">⌘ K</span></button>
					<div className="workspace-heading"><span>{t("Workspaces")}</span><span className="session-count">{workspaces.length}</span><span className="workspace-heading-actions"><IconButton label={searchOpen ? t("Close search") : t("Search sessions")} icon={searchOpen ? X : Search} onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setQuery(""); }} /><IconButton label={t("Workspace display options")} icon={SlidersHorizontal} onClick={() => { const shouldExpand = workspaces.some((workspace) => !(expanded[workspace.id] ?? true)); setExpanded(Object.fromEntries(workspaces.map((workspace) => [workspace.id, shouldExpand]))); }} /><IconButton label={t("Add workspace")} icon={FolderPlus} onClick={() => { setAddError(undefined); setAddOpen(true); }} /></span></div>
					{searchOpen ? <label className="session-search workspace-search"><Search size={15} aria-hidden="true" /><input ref={searchInput} aria-label={t("Search sessions")} placeholder={t("Search sessions")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setQuery(""); } }} /></label> : null}
					<div className="workspace-list" role="tree" aria-label={t("Workspaces")}>
						{workspaces.map((workspace) => {
							const sessions = visibleSessions(workspace.id);
							const isExpanded = expanded[workspace.id] ?? true;
							const isActive = workspace.id === activeWorkspaceId;
							return <section className={`workspace-section${isActive ? " is-active" : ""}`} key={workspace.id} role="treeitem" aria-expanded={isExpanded}>
								<div className="workspace-section-header-wrap"><button className="workspace-section-header" type="button" onClick={() => { setExpanded((current) => ({ ...current, [workspace.id]: !isExpanded })); onSelectWorkspace(workspace.id); }}>
									<span className="workspace-folder-icon">{isExpanded ? <FolderOpen size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />}<ChevronDown size={15} aria-hidden="true" /></span>
									<span className="workspace-section-name">{workspace.name}</span><span className="workspace-session-count">{sessions.length}</span>
								</button><span className="workspace-row-actions"><IconButton label={t("Workspace actions")} icon={MoreHorizontal} onClick={() => onSelectWorkspace(workspace.id)} /><IconButton label={t("New session in workspace")} icon={MessageSquarePlus} onClick={() => onNewSession(workspace.id)} /></span></div>
								{isExpanded ? <div className="workspace-section-sessions"><SessionTree compact actionsEnabled={isActive} sessions={sessions} activeSessionId={isActive ? activeSessionId : undefined} onOpen={(sessionId) => onOpenSession(workspace.id, sessionId)} onRename={onRenameSession} onDelete={onDeleteSession} onBranch={onBranchSession} onInspect={onInspectSession} /></div> : null}
							</section>;
						})}
					</div>
					{sessionWebSlot ? <div className="web-slot-session-tree">{sessionWebSlot}</div> : null}
					{webSlot ? <div className="web-slot-sidebar">{webSlot}</div> : null}
					<div className="sidebar-footer"><button className="footer-button" type="button" onClick={onSettings}><Settings size={17} />{t("Settings")}</button></div>
				</>
			) : <div className="collapsed-actions"><IconButton label={t("New session")} icon={MessageSquarePlus} onClick={onNewSession} /><IconButton label={t("Settings")} icon={Settings} onClick={onSettings} /></div>}
			{addOpen ? <div className="workspace-add-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !adding) setAddOpen(false); }}><div className="workspace-add-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-add-title"><div className="workspace-add-header"><div><p className="eyebrow">{t("Workspaces")}</p><h2 id="workspace-add-title">{t("Add workspace")}</h2></div><IconButton label={t("Close")} icon={X} onClick={() => { if (!adding) setAddOpen(false); }} /></div><p className="workspace-add-note">{t("Choose a local folder to add it to this WebUI.")}</p><button type="button" className="workspace-pick-button" onClick={() => void pickWorkspace()} disabled={adding}><FolderPlus size={17} />{adding ? t("Adding...") : t("Choose a folder")}</button>{addError ? <p className="workspace-add-error" role="alert">{addError}</p> : null}<div className="workspace-add-actions"><button type="button" onClick={() => setAddOpen(false)} disabled={adding}>{t("Cancel")}</button></div></div></div> : null}
		</aside>
	);
}
