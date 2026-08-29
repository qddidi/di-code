import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { callRpc, loadMcpServers, loadPlugins, loadSkills, setPluginEnabled, setProjectTrust } from "../api.ts";
import type { McpServerSummary, PluginSummary, SettingsSnapshot, SkillSummary } from "../types.ts";
import { useI18n } from "../i18n.tsx";

type AdvancedTab = "skills" | "mcp" | "plugins" | "presets" | "trust" | "shortcuts";

interface AdvancedSettingsProps {
	readonly tab: AdvancedTab;
	readonly settings: SettingsSnapshot;
	readonly onError: (message: string | undefined) => void;
	readonly onSettingsChange: () => Promise<void>;
}

interface Preset { readonly id: string; readonly name: string; readonly providerId?: string; readonly modelId?: string; readonly thinkingLevel?: string; readonly permissionMode?: SettingsSnapshot["permissionMode"]; }

function SkillsPanel({ onError }: Pick<AdvancedSettingsProps, "onError">): React.JSX.Element {
	const { t } = useI18n();
	const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
	useEffect(() => { void loadSkills().then(setSkills).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to load Skills.")); }, [onError]);
	return <section className="settings-section"><h3>{t("Skills")}</h3><p className="settings-section-note">{t("Skills are untrusted instructions. Project-local Skills appear only when this Workspace is trusted.")}</p><div className="advanced-list">{skills.length === 0 ? <p className="readonly-note">{t("No Skills discovered.")}</p> : skills.map((skill) => <article className="advanced-row" key={`${skill.scope}:${skill.name}`}><div><strong>{skill.name}</strong><span>{skill.description}</span></div><div className="advanced-meta"><span>{skill.scope}</span><code>/skill:{skill.name}</code></div></article>)}</div></section>;
}

function McpPanel({ onError, onSettingsChange }: Pick<AdvancedSettingsProps, "onError" | "onSettingsChange">): React.JSX.Element {
	const { t } = useI18n();
	const [servers, setServers] = useState<readonly McpServerSummary[]>([]);
	const [serverId, setServerId] = useState("");
	const [command, setCommand] = useState("");
	const [scope, setScope] = useState<"project" | "local" | "user">("project");
	const [pendingAction, setPendingAction] = useState<string>();
	const refresh = async (): Promise<void> => { try { setServers(await loadMcpServers()); } catch (cause) { onError(cause instanceof Error ? cause.message : "Unable to load MCP servers."); } };
	useEffect(() => { void refresh(); }, [onError]);
	const runServerAction = async (action: "reconnect_mcp_server" | "remove_mcp_server", server: McpServerSummary): Promise<void> => {
		if (pendingAction) return;
		setPendingAction(`${action}:${server.id}`);
		try {
			await callRpc(action, action === "remove_mcp_server" ? { serverId: server.id, scope: server.scope ?? "project" } : { serverId: server.id });
			await refresh();
		} catch (cause) { onError(cause instanceof Error ? cause.message : t(action === "remove_mcp_server" ? "MCP remove failed." : "MCP reconnect failed.")); }
		finally { setPendingAction(undefined); }
	};
	const add = async (): Promise<void> => {
		if (pendingAction) return;
		setPendingAction("add");
		try { await callRpc("configure_mcp_server", { serverId, scope, config: { type: "stdio", command, args: [] } }); setServerId(""); setCommand(""); await refresh(); await onSettingsChange(); }
		catch (cause) { onError(cause instanceof Error ? cause.message : "MCP configuration failed."); }
		finally { setPendingAction(undefined); }
	};
	return <section className="settings-section"><h3>{t("MCP servers")}</h3><p className="settings-section-note">{t("Connections are external processes or services. Calls are cancellable and server output remains untrusted.")}</p><div className="advanced-list">{servers.length === 0 ? <p className="readonly-note">{t("No configured servers.")}</p> : servers.map((server) => { const reconnecting = pendingAction === `reconnect_mcp_server:${server.id}`; const removing = pendingAction === `remove_mcp_server:${server.id}`; return <article className="advanced-row" key={`${server.scope}:${server.id}`}><div><strong>{server.id}</strong><span>{server.state} · {server.tools} {t("tools")} · {server.resources} {t("resources")}</span></div><div className="advanced-actions"><button type="button" disabled={Boolean(pendingAction)} aria-busy={reconnecting} onClick={() => void runServerAction("reconnect_mcp_server", server)}>{reconnecting ? <><LoaderCircle className="spin" size={13} />{t("Connecting...")}</> : t("Reconnect")}</button><button type="button" disabled={Boolean(pendingAction)} aria-busy={removing} onClick={() => void runServerAction("remove_mcp_server", server)}>{removing ? <><LoaderCircle className="spin" size={13} />{t("Removing...")}</> : t("Remove")}</button></div></article>; })}</div><div className="inline-form"><input aria-label={t("MCP server id")} placeholder="server-id" value={serverId} onChange={(event) => setServerId(event.target.value)} disabled={Boolean(pendingAction)} /><input aria-label={t("MCP command")} placeholder="command" value={command} onChange={(event) => setCommand(event.target.value)} disabled={Boolean(pendingAction)} /><select aria-label={t("MCP scope")} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)} disabled={Boolean(pendingAction)}><option value="project">{t("Project")}</option><option value="local">{t("Local")}</option><option value="user">{t("User")}</option></select><button type="button" disabled={Boolean(pendingAction) || !serverId.trim() || !command.trim()} aria-busy={pendingAction === "add"} onClick={() => void add()}>{pendingAction === "add" ? <><LoaderCircle className="spin" size={13} />{t("Adding...")}</> : t("Add stdio")}</button></div></section>;
}

function PluginsPanel({ onError }: Pick<AdvancedSettingsProps, "onError">): React.JSX.Element {
	const { t } = useI18n();
	const [plugins, setPlugins] = useState<readonly PluginSummary[]>([]);
	const refresh = (): void => { void loadPlugins().then(setPlugins).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to load plugins.")); };
	useEffect(refresh, [onError]);
	return <section className="settings-section"><h3>{t("Plugins")}</h3><p className="settings-section-note">{t("Plugins run in-process. Permissions describe impact and audit scope; they are not an operating-system sandbox.")}</p><div className="advanced-list">{plugins.length === 0 ? <p className="readonly-note">{t("No plugins discovered.")}</p> : plugins.map((plugin) => { const status = plugin.status ?? (plugin.enabled ? "active" : "disabled"); const canToggle = plugin.source !== "project"; return <article className="advanced-row" key={plugin.id}><div><strong>{plugin.id}</strong><span>v{plugin.version} · {plugin.source ?? "managed"} · {plugin.capabilities.join(", ") || t("no declared capabilities")}</span>{plugin.error ? <span className="plugin-error">{plugin.error}</span> : null}</div><div className={`plugin-status plugin-status-${status}`}>{status}</div>{canToggle ? <label className="switch"><input type="checkbox" checked={plugin.enabled} onChange={(event) => { void setPluginEnabled(plugin.id, event.target.checked).then(refresh).then(() => window.dispatchEvent(new Event("di-code-web-contributions-changed"))).catch((cause) => onError(cause instanceof Error ? cause.message : t("Plugin update failed."))); }} /><span>{t("Enabled")}</span></label> : null}</article>; })}</div></section>;
}

function PresetsPanel({ settings, onError, onSettingsChange }: Pick<AdvancedSettingsProps, "settings" | "onError" | "onSettingsChange">): React.JSX.Element {
	const { t } = useI18n();
	const [presets, setPresets] = useState<readonly Preset[]>(() => { try { return JSON.parse(localStorage.getItem("di-code-presets") ?? "[]") as Preset[]; } catch { return []; } });
	const [name, setName] = useState("");
	const save = (): void => { if (!name.trim()) return; const next = [...presets, { id: crypto.randomUUID(), name: name.trim(), providerId: settings.defaults.providerId, modelId: settings.defaults.modelId, thinkingLevel: settings.runtime.thinkingLevel, permissionMode: settings.permissionMode }]; setPresets(next); localStorage.setItem("di-code-presets", JSON.stringify(next)); setName(""); };
	const apply = async (preset: Preset): Promise<void> => { try { if (preset.providerId) await callRpc("set_default_provider", { providerId: preset.providerId }); if (preset.modelId) await callRpc("set_default_model", { modelId: preset.modelId }); if (preset.permissionMode) await callRpc("set_permission_mode", { permissionMode: preset.permissionMode }); if (preset.thinkingLevel) await callRpc("set_thinking_level", { level: preset.thinkingLevel }); await onSettingsChange(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Preset apply failed."); } };
	return <section className="settings-section"><h3>{t("Agent presets")}</h3><p className="settings-section-note">{t("Presets store non-secret defaults in this browser. Applying one uses explicit settings RPCs; API keys never enter the preset.")}</p><div className="advanced-list">{presets.map((preset) => <article className="advanced-row" key={preset.id}><div><strong>{preset.name}</strong><span>{preset.providerId ?? t("default")} / {preset.modelId ?? t("default")}</span></div><div className="advanced-actions"><button type="button" onClick={() => void apply(preset)}>{t("Apply")}</button><button type="button" onClick={() => { const next = presets.filter((item) => item.id !== preset.id); setPresets(next); localStorage.setItem("di-code-presets", JSON.stringify(next)); }}>{t("Delete")}</button></div></article>)}</div><div className="inline-form"><input aria-label={t("Preset name")} placeholder={t("Preset name")} value={name} onChange={(event) => setName(event.target.value)} /><button type="button" disabled={!name.trim()} onClick={save}>{t("Save current")}</button></div></section>;
}

function TrustPanel({ settings, onError, onSettingsChange }: Pick<AdvancedSettingsProps, "settings" | "onError" | "onSettingsChange">): React.JSX.Element {
	const { t } = useI18n();
	const [trusted, setTrusted] = useState<boolean>();
	useEffect(() => { void callRpc<{ readonly trusted: boolean }>("get_project_trust").then((result) => setTrusted(result.trusted)).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to read Workspace trust.")); }, [onError]);
	const update = async (value: boolean): Promise<void> => { try { setTrusted(await setProjectTrust(value)); await onSettingsChange(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Workspace trust update failed."); } };
	return <section className="settings-section"><h3>{t("Workspace trust")}</h3><p className="settings-section-note">{t("Trust controls project-local Skills, MCP configuration, and project composition loading. It does not grant plugin permissions or create a process sandbox.")}</p><div className="trust-impact"><strong>{trusted ? t("Trusted Workspace") : t("Untrusted Workspace")}</strong><span>{trusted ? t("Project Skills, MCP, and composition entries may load after validation.") : t("Only user-scoped resources load; project-local resources remain skipped.")}</span><small>{t("Workspace path and secrets stay server-side.")}</small></div><button className="trust-toggle" type="button" onClick={() => void update(!trusted)}>{trusted ? t("Revoke trust") : t("Trust this Workspace")}</button><p className="readonly-note">{t("Settings source")}: {settings.sources.provider}; {t("Permission mode")}: {settings.permissionMode}.</p></section>;
}

function ShortcutsPanel(): React.JSX.Element {
	const { t } = useI18n();
	return <section className="settings-section"><h3>{t("Shortcuts")}</h3><p className="settings-section-note">{t("Keyboard actions are presentation-only and never bypass RPC authorization or approvals.")}</p><div className="shortcut-list"><span><kbd>Enter</kbd> {t("Send")}</span><span><kbd>Shift+Enter</kbd> {t("New line")}</span><span><kbd>Esc</kbd> {t("Cancel active response")}</span><span><kbd>Ctrl/⌘ K</kbd> {t("New session")}</span><span><kbd>Ctrl/⌘ ,</kbd> {t("Settings")}</span></div></section>;
}

export function AdvancedSettings({ tab, settings, onError, onSettingsChange }: AdvancedSettingsProps): React.JSX.Element {
	switch (tab) {
		case "skills": return <SkillsPanel onError={onError} />;
		case "mcp": return <McpPanel onError={onError} onSettingsChange={onSettingsChange} />;
		case "plugins": return <PluginsPanel onError={onError} />;
		case "presets": return <PresetsPanel settings={settings} onError={onError} onSettingsChange={onSettingsChange} />;
		case "trust": return <TrustPanel settings={settings} onError={onError} onSettingsChange={onSettingsChange} />;
		case "shortcuts": return <ShortcutsPanel />;
	}
}

export type { AdvancedTab };
