import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./components/Composer.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { SettingsOverlay } from "./components/SettingsOverlay.tsx";
import { OnboardingPanel } from "./components/OnboardingPanel.tsx";
import { loadSettings } from "./api.ts";
import type { SettingsSnapshot } from "./types.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkspaceBar } from "./components/WorkspaceBar.tsx";
import { useBoot } from "./use-boot.ts";
import "./styles.css";
import "./settings.css";

function App(): React.JSX.Element {
	const { data, error, loading, sessions } = useBoot();
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 800);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
	const [settings, setSettings] = useState<SettingsSnapshot>();
	const [onboarding, setOnboarding] = useState(false);
	useEffect(() => { void loadSettings().then((value) => { setSettings(value); setOnboarding(value.providers.every((provider) => !provider.configured)); }).catch(() => undefined); }, []);
	if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
	return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
		<Sidebar collapsed={sidebarCollapsed} sessions={sessions} onToggle={() => setSidebarCollapsed((value) => !value)} onNewSession={() => undefined} onSettings={() => setSettingsOpen(true)} />
		<div className="main-column"><WorkspaceBar onToggleSidebar={() => setSidebarCollapsed((value) => !value)} onSettings={() => setSettingsOpen(true)} /><main className="main-content">
			{error ? <div className="connection-banner" role="alert">{error}</div> : null}
			{loading ? <div className="loading-state" aria-busy="true">Loading workspace...</div> : <><EmptyState /><Composer disabled={data === undefined} /></>}
		</main></div>
		<SettingsOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} onThemeChange={setTheme} />
		{onboarding && settings ? <OnboardingPanel settings={settings} onComplete={() => { setOnboarding(false); void loadSettings().then(setSettings); }} /> : null}
	</div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
