import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { callRpc, loadSettings } from "../api.ts";
import type { SettingsSnapshot } from "../types.ts";
import { GeneralSettings } from "./GeneralSettings.tsx";
import { IconButton } from "./IconButton.tsx";
import { ModelsSettings } from "./ModelsSettings.tsx";

interface SettingsOverlayProps { readonly open: boolean; readonly onClose: () => void; readonly theme: "light" | "dark" | "system"; readonly onThemeChange: (theme: "light" | "dark" | "system") => void; }

export function SettingsOverlay({ open, onClose, theme, onThemeChange }: SettingsOverlayProps): React.JSX.Element | null {
	const [tab, setTab] = useState<"general" | "models">("general");
	const [settings, setSettings] = useState<SettingsSnapshot>();
	const [error, setError] = useState<string>();
	useEffect(() => { if (!open) return; void loadSettings().then(setSettings).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load settings.")); }, [open]);
	if (!open) return null;
	const update = async (method: string, params: Record<string, unknown>): Promise<void> => { try { await callRpc(method, params); setSettings(await loadSettings()); setError(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings update failed."); } };
	return <div className="overlay" role="presentation"><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="settings-header"><div><p className="eyebrow">Workspace preferences</p><h2 id="settings-title">Settings</h2></div><IconButton label="Close settings" icon={X} onClick={onClose} /></div><nav className="settings-nav" aria-label="Settings sections"><button className={`settings-nav-item${tab === "general" ? " is-selected" : ""}`} type="button" onClick={() => setTab("general")}>General</button><button className={`settings-nav-item${tab === "models" ? " is-selected" : ""}`} type="button" onClick={() => setTab("models")}>Models</button></nav><div className="settings-content">{error ? <div className="settings-error" role="alert">{error}</div> : null}{settings ? tab === "general" ? <GeneralSettings settings={settings} theme={theme} onThemeChange={onThemeChange} onLocaleChange={(locale) => void update("set_locale", { locale })} onPermissionChange={(permissionMode) => void update("set_permission_mode", { permissionMode })} onThinkingChange={(level) => void update("set_thinking_level", level === "default" ? {} : { level })} /> : <ModelsSettings settings={settings} onDefaultModel={(modelId) => void update("set_default_model", { modelId })} onLogin={(providerId, apiKey, modelId) => update("login", { providerId, apiKey, ...(modelId ? { modelId } : {}) })} onLogout={(providerId) => update("logout", { providerId })} onCustomProvider={(input) => update("configure_custom_provider", input)} /> : <div className="settings-loading" aria-busy="true">Loading settings...</div>}</div></section></div>;
}
