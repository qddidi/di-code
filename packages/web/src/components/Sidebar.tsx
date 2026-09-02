import { ChevronDown, Folder, FolderOpen, FolderPlus, MoreHorizontal, PanelLeftClose, Pencil, Search, Settings, Sparkles, X } from "lucide-react";
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
	readonly onAddWorkspace: (path?: string) => Promise<WorkspaceSummary | undefined>;
	readonly onRenameWorkspace: (id: string, name: string) => Promise<void>;
	readonly onDeleteWorkspace: (id: string) => Promise<void>;
	readonly collapsed: boolean;
	readonly onToggle: () => void;
	readonly onNewSession: (workspaceId?: string) => void;
	readonly activeSessionId?: string;
	readonly runningSessionIds: ReadonlySet<string>;
	readonly onOpenSession: (workspaceId: string, sessionId: string) => void;
	readonly onSettings: () => void;
	readonly onRenameSession: (id: string, label: string) => Promise<void>;
	readonly onDeleteSession: (id: string) => Promise<void>;
	readonly onBranchSession: (id: string) => Promise<void>;
	readonly onInspectSession: (id: string) => Promise<unknown>;
	readonly webSlot?: React.ReactNode;
	readonly sessionWebSlot?: React.ReactNode;
}

export function Sidebar({ sessionsByWorkspace, workspaces, activeWorkspaceId, onSelectWorkspace, onAddWorkspace, onRenameWorkspace, onDeleteWorkspace, collapsed, onToggle, onNewSession, onSettings, activeSessionId, runningSessionIds, onOpenSession, onRenameSession, onDeleteSession, onBranchSession, onInspectSession, webSlot, sessionWebSlot }: SidebarProps): React.JSX.Element {
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});
	const [addOpen, setAddOpen] = useState(false);
	const [addError, setAddError] = useState<string>();
	const [adding, setAdding] = useState(false);
	const [workspaceMenu, setWorkspaceMenu] = useState<string>();
	const [workspaceEditing, setWorkspaceEditing] = useState<string>();
	const [workspaceName, setWorkspaceName] = useState("");
	const searchInput = useRef<HTMLInputElement>(null);

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
	const dropWorkspace = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
		event.preventDefault();
		const file = event.dataTransfer.files[0] as (File & { readonly path?: string }) | undefined;
		if (!file?.path) {
			setAddError(t("Drag a folder from your file manager."));
			return;
		}
		setAddError(undefined);
		setAdding(true);
		try {
			await onAddWorkspace(file.path);
			setAddOpen(false);
		} catch (cause) {
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
					<button className="new-session" type="button" onClick={() => onNewSession()}><Pencil size={17} aria-hidden="true" />{t("New session")}<span className="shortcut">⌘ K</span></button>
					<div className="workspace-heading"><span>{t("Workspaces")}</span><span className="workspace-heading-actions"><IconButton label={searchOpen ? t("Close search") : t("Search sessions")} icon={searchOpen ? X : Search} onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setQuery(""); }} /><IconButton label={t("Add workspace")} icon={FolderPlus} onClick={() => { setAddError(undefined); setAddOpen(true); }} /></span></div>
					{searchOpen ? <label className="session-search workspace-search"><Search size={15} aria-hidden="true" /><input ref={searchInput} aria-label={t("Search sessions")} placeholder={t("Search sessions")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setQuery(""); } }} /></label> : null}
					<div className="workspace-list" role="tree" aria-label={t("Workspaces")}>
						{workspaces.map((workspace) => {
							const sessions = visibleSessions(workspace.id);
							const isExpanded = expanded[workspace.id] ?? true;
							const isActive = workspace.id === activeWorkspaceId;
							return <section className={`workspace-section${isActive ? " is-active" : ""}`} key={workspace.id} role="treeitem" aria-expanded={isExpanded}>
								<div className="workspace-section-header-wrap"><button className="workspace-section-header" type="button" onClick={() => { setExpanded((current) => ({ ...current, [workspace.id]: !isExpanded })); onSelectWorkspace(workspace.id); }}>
									<span className="workspace-folder-icon">{isExpanded ? <FolderOpen size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />}<ChevronDown size={15} aria-hidden="true" /></span>
									{workspaceEditing === workspace.id ? <input className="workspace-inline-name" autoFocus value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") { void onRenameWorkspace(workspace.id, workspaceName).finally(() => setWorkspaceEditing(undefined)); } if (event.key === "Escape") setWorkspaceEditing(undefined); }} /> : <span className="workspace-section-name">{workspace.name}</span>}
								</button><span className="workspace-row-actions"><span className="workspace-menu-anchor"><IconButton label={t("Workspace actions")} icon={MoreHorizontal} onClick={() => setWorkspaceMenu((current) => current === workspace.id ? undefined : workspace.id)} />{workspaceMenu === workspace.id ? <div className="workspace-action-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setWorkspaceMenu(undefined); setWorkspaceEditing(workspace.id); setWorkspaceName(workspace.name); }}><span>{t("Rename")}</span></button><button type="button" role="menuitem" onClick={() => { setWorkspaceMenu(undefined); if (window.confirm(t("Delete this workspace?"))) void onDeleteWorkspace(workspace.id); }}><span>{t("Delete")}</span></button></div> : null}</span><IconButton label={t("New session in workspace")} icon={Pencil} onClick={() => onNewSession(workspace.id)} /></span></div>
															{isExpanded ? <div className="workspace-section-sessions"><SessionTree compact actionsEnabled={isActive} sessions={sessions} activeSessionId={isActive ? activeSessionId : undefined} runningSessionIds={runningSessionIds} onOpen={(sessionId) => onOpenSession(workspace.id, sessionId)} onRename={onRenameSession} onDelete={onDeleteSession} onBranch={onBranchSession} onInspect={onInspectSession} /></div> : null}
							</section>;
						})}
					</div>
					{sessionWebSlot ? <div className="web-slot-session-tree">{sessionWebSlot}</div> : null}
					{webSlot ? <div className="web-slot-sidebar">{webSlot}</div> : null}
					<div className="sidebar-footer"><button className="footer-button" type="button" onClick={onSettings}><Settings size={17} />{t("Settings")}</button></div>
				</>
			) : <div className="collapsed-actions"><IconButton label={t("New session")} icon={Pencil} onClick={() => onNewSession()} /><IconButton label={t("Settings")} icon={Settings} onClick={onSettings} /></div>}
			{addOpen ? <div className="workspace-add-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !adding) setAddOpen(false); }}><div className="workspace-add-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-add-title"><div className="workspace-add-header"><div><p className="eyebrow">{t("Workspaces")}</p><h2 id="workspace-add-title">{t("Add workspace")}</h2></div><IconButton label={t("Close")} icon={X} onClick={() => { if (!adding) setAddOpen(false); }} /></div><div className="workspace-drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropWorkspace(event)}><FolderPlus size={22} /><span>{t("Drop a folder here")}</span><small>{t("or choose a folder")}</small></div><button type="button" className="workspace-pick-button" onClick={() => void pickWorkspace()} disabled={adding}><FolderPlus size={17} />{adding ? t("Adding...") : t("Choose a folder")}</button>{addError ? <p className="workspace-add-error" role="alert">{addError}</p> : null}<div className="workspace-add-actions"><button type="button" onClick={() => setAddOpen(false)} disabled={adding}>{t("Cancel")}</button></div></div></div> : null}
		</aside>
	);
}
