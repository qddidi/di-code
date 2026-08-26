import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./components/Composer.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { RuntimeControls } from "./components/RuntimeControls.tsx";
import { SettingsOverlay } from "./components/SettingsOverlay.tsx";
import { OnboardingPanel } from "./components/OnboardingPanel.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { loadSettings } from "./api.ts";
import type { SettingsSnapshot } from "./types.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkspaceBar } from "./components/WorkspaceBar.tsx";
import { ApprovalBar } from "./components/ApprovalBar.tsx";
import { Trajectory } from "./components/Trajectory.tsx";
import { useBoot } from "./use-boot.ts";
import { useConversation } from "./use-conversation.ts";
import "./styles.css";
import "./settings.css";

function App(): React.JSX.Element {
	const { data, error: bootError, loading } = useBoot();
	const conversation = useConversation(data !== undefined);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 800);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
	const [settings, setSettings] = useState<SettingsSnapshot>();
	const [onboarding, setOnboarding] = useState(false);
	const [tab, setTab] = useState<"chat" | "trajectory">("chat");
	useEffect(() => { void loadSettings().then((value) => { setSettings(value); setOnboarding(value.providers.every((provider) => !provider.configured)); }).catch(() => undefined); }, []);
	if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
	const busy = conversation.operation?.status === "queued" || conversation.operation?.status === "running";
	const retryable = conversation.operation?.status === "failed" || conversation.operation?.status === "cancelled";
	return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
		<Sidebar collapsed={sidebarCollapsed} sessions={conversation.sessions} activeSessionId={conversation.activeSessionId} onToggle={() => setSidebarCollapsed((value) => !value)} onNewSession={() => { void conversation.newSession(); }} onOpenSession={(id) => { void conversation.openSession(id); }} onRenameSession={conversation.renameSession} onDeleteSession={conversation.deleteSession} onBranchSession={conversation.branchSession} onInspectSession={conversation.inspectSession} onSettings={() => setSettingsOpen(true)} />
		<div className="main-column"><WorkspaceBar onToggleSidebar={() => setSidebarCollapsed((value) => !value)} onSettings={() => setSettingsOpen(true)} /><main className="main-content">
			{bootError || conversation.error ? <div className="connection-banner" role="alert">{conversation.error ?? bootError}</div> : null}
			{!conversation.connected && !conversation.error ? <div className="connection-state" role="status">Reconnecting to session events...</div> : null}
			{loading ? <div className="loading-state" aria-busy="true">Loading workspace...</div> : <><nav className="conversation-tabs" aria-label="Conversation views"><button type="button" className={tab === "chat" ? "is-selected" : ""} onClick={() => setTab("chat")}>Chat</button><button type="button" className={tab === "trajectory" ? "is-selected" : ""} onClick={() => setTab("trajectory")}>Trajectory{conversation.tools.length ? ` (${conversation.tools.length})` : ""}</button></nav>{tab === "chat" ? <>{conversation.messages.length === 0 ? <EmptyState /> : <Transcript messages={conversation.messages} canRetry={retryable} onRetry={() => { void conversation.retry(); }} />}</> : <Trajectory tools={conversation.tools} contextFiles={conversation.contextFiles} compaction={conversation.compaction} />}<ApprovalBar approvals={conversation.approvals} onApprove={(id, approved) => { void conversation.approveTool(id, approved); }} /><RuntimeControls operation={conversation.operation} usage={conversation.usage} onCancel={() => { void conversation.cancel(); }} onCompact={() => { void conversation.compact(); }} onRetry={() => { void conversation.retry(); }} /><Composer disabled={data === undefined} busy={busy} attachments={conversation.attachments} onAddFiles={conversation.addFiles} onRemoveAttachment={conversation.removeAttachment} onSend={conversation.send} onSteer={conversation.steer} onCancel={conversation.cancel} /></>}
		</main></div>
		<SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} onThemeChange={setTheme} />
		{onboarding && settings ? <OnboardingPanel settings={settings} onComplete={() => { setOnboarding(false); void loadSettings().then(setSettings); }} /> : null}
	</div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
