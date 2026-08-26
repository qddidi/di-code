import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { callRpc, loadSettings } from "../api.ts";
import type { SettingsSnapshot } from "../types.ts";
import { AdvancedSettings, type AdvancedTab } from "./AdvancedSettings.tsx";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { IconButton } from "./IconButton.tsx";
import { ModelsSettings } from "./ModelsSettings.tsx";

interface SettingsOverlayProps { readonly open: boolean; readonly onClose: () => void; readonly theme: "light" | "dark" | "system"; readonly onThemeChange: (theme: "light" | "dark" | "system") => void; readonly webSlot?: React.ReactNode; }
const advancedTabs: readonly { id: AdvancedTab; label: string }[] = [{ id: "skills", label: "Skills" }, { id: "mcp", label: "MCP" }, { id: "plugins", label: "Plugins" }, { id: "presets", label: "Presets" }, { id: "trust", label: "Trust" }, { id: "shortcuts", label: "Shortcuts" }];

export function SettingsOverlay({ open, onClose, theme, onThemeChange, webSlot }: SettingsOverlayProps): React.JSX.Element | null {
	const [tab, setTab] = useState<"general" | "models" | AdvancedTab>("general");
	const [settings, setSettings] = useState<SettingsSnapshot>();
	const [error, setError] = useState<string>();
	useEffect(() => { if (!open) return; void loadSettings().then(setSettings).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load settings.")); }, [open]);
	if (!open) return null;
	const update = async (method: string, params: Record<string, unknown>): Promise<void> => { try { await callRpc(method, params); setSettings(await loadSettings()); setError(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings update failed."); } };
	const refresh = async (): Promise<void> => { setSettings(await loadSettings()); };
	return <div className="overlay" role="presentation"><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="settings-header"><div><p className="eyebrow">Workspace preferences</p><h2 id="settings-title">Settings</h2></div><IconButton label="Close settings" icon={X} onClick={onClose} /></div><nav className="settings-nav" aria-label="Settings sections"><button className={`settings-nav-item${tab === "general" ? " is-selected" : ""}`} type="button" onClick={() => setTab("general")}>General</button><button className={`settings-nav-item${tab === "models" ? " is-selected" : ""}`} type="button" onClick={() => setTab("models")}>Models</button>{advancedTabs.map((item) => <button key={item.id} className={`settings-nav-item${tab === item.id ? " is-selected" : ""}`} type="button" onClick={() => setTab(item.id)}>{item.label}</button>)}</nav><div className="settings-content">{error ? <div className="settings-error" role="alert">{error}</div> : null}{settings ? tab === "general" ? <GeneralSettings settings={settings} theme={theme} onThemeChange={onThemeChange} onLocaleChange={(locale) => void update("set_locale", { locale })} onPermissionChange={(permissionMode) => void update("set_permission_mode", { permissionMode })} onThinkingChange={(level) => void update("set_thinking_level", level === "default" ? {} : { level })} /> : tab === "models" ? <ModelsSettings settings={settings} onDefaultModel={(modelId) => void update("set_default_model", { modelId })} onLogin={(providerId, apiKey, modelId) => update("login", { providerId, apiKey, ...(modelId ? { modelId } : {}) })} onLogout={(providerId) => update("logout", { providerId })} onCustomProvider={(input) => update("configure_custom_provider", input)} /> : <AdvancedSettings tab={tab} settings={settings} onError={setError} onSettingsChange={refresh} /> : <div className="settings-loading" aria-busy="true">Loading settings...</div>}{webSlot ? <div className="web-slot-settings">{webSlot}</div> : null}</div></section></div>;
}
