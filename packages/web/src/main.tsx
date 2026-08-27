import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoaderCircle } from "lucide-react";
import { Composer } from "./components/Composer.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { SettingsOverlay } from "./components/SettingsOverlay.tsx";
import { OnboardingPanel } from "./components/OnboardingPanel.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { addWorkspace, callRpc, loadSessionsForWorkspace, loadSettings, loadWebContributions, selectWorkspace } from "./api.ts";
import type { SessionSummary, SettingsSnapshot, WebManifest, WorkspaceSummary } from "./types.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkspaceBar } from "./components/WorkspaceBar.tsx";
import { ApprovalBar } from "./components/ApprovalBar.tsx";
import { Trajectory } from "./components/Trajectory.tsx";
import { LoadingSkeleton } from "./components/LoadingSkeleton.tsx";
import { SessionLogOverlay } from "./components/SessionLogOverlay.tsx";
import { Toast } from "./components/Toast.tsx";
import { TreeDialog } from "./components/TreeDialog.tsx";
import { useBoot } from "./use-boot.ts";
import { useConversation } from "./use-conversation.ts";
import "./styles.css";
import "./settings.css";
import { createWebSlotHost, WebSlot } from "./web-slots.tsx";
import { I18nProvider, useI18n } from "./i18n.tsx";

function App(): React.JSX.Element {
	const { setLocale } = useI18n();
	const { data, error: bootError, loading, workspaceSessions } = useBoot();
	const [workspaceId, setWorkspaceId] = useState<string>();
	selectWorkspace(workspaceId);
	const conversation = useConversation(data !== undefined, workspaceId);
	const [pendingSession, setPendingSession] = useState<{ readonly workspaceId: string; readonly sessionId: string }>();
	const [pendingNewWorkspace, setPendingNewWorkspace] = useState<string>();
	const [addedWorkspaces, setAddedWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
	const [addedWorkspaceSessions, setAddedWorkspaceSessions] = useState<Readonly<Record<string, readonly SessionSummary[]>>>({});
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 800);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
	const [settings, setSettings] = useState<SettingsSnapshot>();
	const [onboarding, setOnboarding] = useState(false);
	const [sessionLogOpen, setSessionLogOpen] = useState(false);
	const [treeOpen, setTreeOpen] = useState(false);
	const [restoredDraft, setRestoredDraft] = useState<{ readonly id: string; readonly text: string }>();
	const [toast, setToast] = useState<string>();
	const [tab, setTab] = useState<"chat" | "trajectory">("chat");
	const [webManifest, setWebManifest] = useState<WebManifest>({ protocolVersion: 1, contributions: [] });
	const webAbort = useMemo(() => new AbortController(), []);
	const webActions = useMemo(() => ({ openSettings: () => setSettingsOpen(true), focusSession: (id: string) => { void conversation.openSession(id); } }), [conversation.openSession]);
	const webHost = useMemo(() => createWebSlotHost(webManifest, webActions), [webManifest, webActions]);
	const refreshSettings = useCallback(async (): Promise<SettingsSnapshot> => {
		const value = await loadSettings();
		setSettings(value);
		setLocale(value.locale === "zh-CN" ? "zh-CN" : "en");
		setOnboarding(value.providers.every((provider) => !provider.configured));
		return value;
	}, []);
	const updateSettings = useCallback(async (method: string, params: Record<string, unknown>): Promise<void> => {
		await callRpc(method, params);
		await refreshSettings();
	}, [refreshSettings]);
	useEffect(() => () => { webAbort.abort(); webHost.dispose(); }, [webAbort, webHost]);
	useEffect(() => {
		const refreshWebContributions = (): void => { void loadWebContributions().then(setWebManifest).catch(() => undefined); };
		refreshWebContributions();
		window.addEventListener("di-code-web-contributions-changed", refreshWebContributions);
		return () => window.removeEventListener("di-code-web-contributions-changed", refreshWebContributions);
	}, []);
	useEffect(() => {
		if (!data) return;
		setWorkspaceId((current) => current ?? data.workspaceId);
		let active = true;
		const load = async (attempt: number): Promise<void> => {
			try {
				await refreshSettings();
			} catch {
				if (active && attempt === 0) window.setTimeout(() => void load(1), 150);
			}
		};
		void load(0);
		return () => {
			active = false;
		};
	}, [data, refreshSettings]);
	useEffect(() => {
		if (!pendingSession || pendingSession.workspaceId !== workspaceId) return;
		setPendingSession(undefined);
		void conversation.openSession(pendingSession.sessionId);
	}, [conversation.openSession, pendingSession, workspaceId]);
	useEffect(() => {
		if (!pendingNewWorkspace || pendingNewWorkspace !== workspaceId) return;
		setPendingNewWorkspace(undefined);
		void conversation.newSession();
	}, [conversation.newSession, pendingNewWorkspace, workspaceId]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const modifier = event.ctrlKey || event.metaKey;
			if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarCollapsed(false); }
			if (modifier && event.key === ",") { event.preventDefault(); setSettingsOpen(true); }
			if (event.key === "Escape" && settingsOpen) { event.preventDefault(); setSettingsOpen(false); }
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [settingsOpen]);
	if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
	const busy = conversation.operation?.status === "queued" || conversation.operation?.status === "running";
	const waitingForResponse =
		busy &&
		conversation.operation?.kind !== "compact" &&
		!conversation.messages.some((message) => message.role === "assistant" && message.status === "streaming");
	const retryable = conversation.operation?.status === "failed" || conversation.operation?.status === "cancelled";
	const hero = conversation.messages.length === 0 && !busy;
	const activeTitle = conversation.sessions.find((session) => session.id === conversation.activeSessionId)?.label;
	const activeSession = conversation.sessions.find((session) => session.id === conversation.activeSessionId);
	const sessionsByWorkspace = useMemo(() => ({ ...workspaceSessions, ...(workspaceId ? { [workspaceId]: conversation.sessions } : {}) }), [conversation.sessions, workspaceId, workspaceSessions]);
	const allWorkspaces = useMemo(() => [...(data?.workspaces ?? []), ...addedWorkspaces.filter((added) => !(data?.workspaces ?? []).some((workspace) => workspace.id === added.id))], [addedWorkspaces, data?.workspaces]);
	const allSessionsByWorkspace = useMemo(() => ({ ...sessionsByWorkspace, ...addedWorkspaceSessions, ...(workspaceId ? { [workspaceId]: conversation.sessions } : {}) }), [addedWorkspaceSessions, conversation.sessions, sessionsByWorkspace, workspaceId]);
	const runtimeProvider = settings?.providers.find((provider) => provider.id === settings.runtime.providerId);
	const runtimeModel = runtimeProvider?.models.find((model) => model.id === settings?.runtime.modelId);
	const imageInputSupported = runtimeModel?.input.includes("image") ?? false;
	const runtimeOptions = runtimeProvider?.models.map((model) => ({ providerId: runtimeProvider.id, providerName: runtimeProvider.name, modelId: model.id, label: model.name })) ?? [];
	const reasoningEfforts =
		runtimeModel?.reasoningEfforts ??
		(settings?.runtime.providerId === "zhipu" && ["glm-5.2", "glm-5.3"].includes(settings.runtime.modelId)
			? (["low", "high", "max"] as const)
			: []);
	const modelLabel = `${settings?.runtime.modelId ?? data?.runtime.modelId ?? "Model"}${settings?.runtime.thinkingLevel ? ` ${settings.runtime.thinkingLevel[0]?.toUpperCase()}${settings.runtime.thinkingLevel.slice(1)}` : ""}`;
	const setRuntime = async (providerId: string, modelId: string): Promise<void> => {
		await updateSettings("set_runtime", { providerId, modelId });
	};
	const setPermissionMode = async (permissionMode: SettingsSnapshot["permissionMode"]): Promise<void> => {
		setSettings((current) => current ? { ...current, permissionMode } : current);
		try {
			await updateSettings("set_permission_mode", { permissionMode });
		} catch {
			void refreshSettings();
		}
	};
	const setThinkingLevel = async (level: "low" | "medium" | "high" | "max"): Promise<void> => {
		await updateSettings("set_thinking_level", { level });
	};
	useEffect(() => {
		const message = conversation.operation?.status === "failed" ? conversation.operation.error?.message : undefined;
		if (!message) return;
		setToast(message);
		const timer = window.setTimeout(() => setToast((current) => (current === message ? undefined : current)), 5_000);
		return () => window.clearTimeout(timer);
	}, [conversation.operation?.error?.message, conversation.operation?.status]);
	const openWorkspaceSession = (targetWorkspaceId: string, sessionId: string): void => {
		if (targetWorkspaceId === workspaceId) void conversation.openSession(sessionId);
		else {
			setPendingSession({ workspaceId: targetWorkspaceId, sessionId });
			setWorkspaceId(targetWorkspaceId);
		}
	};
	const handleAddWorkspace = async (path: string): Promise<WorkspaceSummary> => {
		const workspace = await addWorkspace(path);
		setAddedWorkspaces((current) => current.some((item) => item.id === workspace.id) ? current : [...current, workspace]);
		try {
			const result = await loadSessionsForWorkspace(workspace.id);
			setAddedWorkspaceSessions((current) => ({ ...current, [workspace.id]: result.sessions }));
		} catch {
			setAddedWorkspaceSessions((current) => ({ ...current, [workspace.id]: [] }));
		}
		setPendingSession(undefined);
		setWorkspaceId(workspace.id);
		return workspace;
	};
	const createWorkspaceSession = (targetWorkspaceId?: string): void => {
		if (!targetWorkspaceId || targetWorkspaceId === workspaceId) void conversation.newSession();
		else {
			setPendingSession(undefined);
			setPendingNewWorkspace(targetWorkspaceId);
			setWorkspaceId(targetWorkspaceId);
		}
	};
	return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${hero ? " is-hero" : " is-active"}`}>
		<Sidebar collapsed={sidebarCollapsed} sessionsByWorkspace={allSessionsByWorkspace} workspaces={allWorkspaces} activeWorkspaceId={workspaceId} onSelectWorkspace={(id) => { setPendingSession(undefined); setPendingNewWorkspace(undefined); setWorkspaceId(id); }} onAddWorkspace={handleAddWorkspace} activeSessionId={conversation.activeSessionId} onToggle={() => setSidebarCollapsed((value) => !value)} onNewSession={createWorkspaceSession} onOpenSession={openWorkspaceSession} onRenameSession={conversation.renameSession} onDeleteSession={conversation.deleteSession} onBranchSession={conversation.branchSession} onInspectSession={conversation.inspectSession} onSettings={() => setSettingsOpen(true)} webSlot={<WebSlot host={webHost} slot="app.sidebar" context={{ sessionId: conversation.activeSessionId }} actions={webActions} signal={webAbort.signal} />} sessionWebSlot={<WebSlot host={webHost} slot="session.tree" context={{ sessionId: conversation.activeSessionId }} actions={webActions} signal={webAbort.signal} />} />
		<div className="main-column">{!hero ? <WorkspaceBar title={activeTitle} onToggleSidebar={() => setSidebarCollapsed((value) => !value)} onSettings={() => setSettingsOpen(true)} onSessionLog={() => setSessionLogOpen(true)} /> : null}<main className={`main-content${hero ? " is-hero" : ""}`}>
			{bootError || conversation.error ? <div className="connection-banner" role="alert">{conversation.error ?? bootError}</div> : null}
			{!conversation.connected && !conversation.error ? <div className="connection-state" role="status">Reconnecting to session events...</div> : null}
			{loading ? <LoadingSkeleton /> : <>{!hero ? <nav className="conversation-tabs" aria-label="Conversation views"><button type="button" className={tab === "chat" ? "is-selected" : ""} onClick={() => setTab("chat")}>Chat</button><button type="button" className={tab === "trajectory" ? "is-selected" : ""} onClick={() => setTab("trajectory")}>Trajectory{conversation.tools.length ? ` (${conversation.tools.length})` : ""}</button></nav> : null}{tab === "chat" ? <>{conversation.messages.length === 0 && !waitingForResponse ? <EmptyState /> : <Transcript messages={conversation.messages} waitingForResponse={waitingForResponse} canRetry={retryable} onRetry={() => { void conversation.retry(); }} onBranch={(entryId) => { if (conversation.activeSessionId) void conversation.branchSession(conversation.activeSessionId, entryId); }} webSlot={<WebSlot host={webHost} slot="conversation.node" context={{ sessionId: conversation.activeSessionId }} actions={webActions} signal={webAbort.signal} />} />}</> : <Trajectory tools={conversation.tools} contextFiles={conversation.contextFiles} compaction={conversation.compaction} />}<WebSlot host={webHost} slot="conversation.tool" context={{ sessionId: conversation.activeSessionId, toolName: conversation.tools.at(-1)?.name, status: conversation.tools.at(-1)?.status }} actions={webActions} signal={webAbort.signal} /><ApprovalBar approvals={conversation.approvals} onApprove={(id, approved) => { void conversation.approveTool(id, approved); }} />{conversation.compaction?.state === "running" ? <div className="compaction-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={14} /><span>Compacting context</span><span className="streaming-dots" aria-hidden="true"><i /><i /><i /></span></div> : null}<Composer disabled={data === undefined} busy={busy} hero={hero} modelLabel={modelLabel} activeRuntime={{ providerId: settings?.runtime.providerId ?? data?.runtime.providerId ?? "", modelId: settings?.runtime.modelId ?? data?.runtime.modelId ?? "" }} permissionMode={settings?.permissionMode ?? "ask"} thinkingLevel={settings?.runtime.thinkingLevel} reasoningEfforts={reasoningEfforts} retryable={retryable} runtimeOptions={runtimeOptions} usage={conversation.usage} commands={conversation.commands} restoredDraft={restoredDraft} attachments={conversation.attachments} imageInputSupported={imageInputSupported} onAddFiles={conversation.addFiles} onRemoveAttachment={conversation.removeAttachment} onSend={conversation.send} onSteer={conversation.steer} onCancel={conversation.cancel} onCompact={conversation.compact} onRunCommand={conversation.runCommand} onRetry={conversation.retry} onClear={conversation.clearVisibleMessages} onOpenSessions={() => setSidebarCollapsed(false)} onOpenTree={() => setTreeOpen(true)} onOpenUsage={() => setSessionLogOpen(true)} onOpenSettings={() => setSettingsOpen(true)} onLogout={() => updateSettings("logout", { providerId: settings?.runtime.providerId ?? data?.runtime.providerId ?? "" })} onSetRuntime={setRuntime} onSetPermissionMode={setPermissionMode} onSetThinkingLevel={setThinkingLevel} /></>}
		</main></div>
		<SettingsOverlay open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} theme={theme} onThemeChange={setTheme} onSettingsUpdate={updateSettings} onSettingsRefresh={refreshSettings} webSlot={<WebSlot host={webHost} slot="settings.panel" context={{}} actions={webActions} signal={webAbort.signal} />} />
		<SessionLogOverlay open={sessionLogOpen} session={activeSession} usage={conversation.usage} onClose={() => setSessionLogOpen(false)} />
		<TreeDialog open={treeOpen} tree={conversation.tree} onClose={() => setTreeOpen(false)} onContinue={async (entryId) => { const result = await conversation.navigateTree(entryId); if (!result) return false; if (result.editorText !== undefined) setRestoredDraft({ id: crypto.randomUUID(), text: result.editorText }); return true; }} />
		<Toast message={toast} onClose={() => setToast(undefined)} />
		{onboarding && settings ? <OnboardingPanel settings={settings} onComplete={() => { setOnboarding(false); void loadSettings().then(setSettings); }} /> : null}
	</div>;
}

const container = document.getElementById("root")! as HTMLElement & { __diCodeRoot?: Root };
const root = container.__diCodeRoot ?? createRoot(container);
container.__diCodeRoot = root;
root.render(<StrictMode><I18nProvider><App /></I18nProvider></StrictMode>);
