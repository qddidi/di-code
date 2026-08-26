import { useEffect, useState } from "react";
import { callRpc, loadMcpServers, loadPlugins, loadSkills, setPluginEnabled, setProjectTrust } from "../api.ts";
import type { McpServerSummary, PluginSummary, SettingsSnapshot, SkillSummary } from "../types.ts";

type AdvancedTab = "skills" | "mcp" | "plugins" | "presets" | "trust" | "shortcuts";

interface AdvancedSettingsProps {
	readonly tab: AdvancedTab;
	readonly settings: SettingsSnapshot;
	readonly onError: (message: string | undefined) => void;
	readonly onSettingsChange: () => Promise<void>;
}

interface Preset { readonly id: string; readonly name: string; readonly providerId?: string; readonly modelId?: string; readonly thinkingLevel?: string; readonly permissionMode?: SettingsSnapshot["permissionMode"]; }

function SkillsPanel({ onError }: Pick<AdvancedSettingsProps, "onError">): React.JSX.Element {
	const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
	useEffect(() => { void loadSkills().then(setSkills).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to load Skills.")); }, [onError]);
	return <section className="settings-section"><h3>Skills</h3><p className="settings-section-note">Skills are untrusted instructions. Project-local Skills appear only when this Workspace is trusted.</p><div className="advanced-list">{skills.length === 0 ? <p className="readonly-note">No Skills discovered.</p> : skills.map((skill) => <article className="advanced-row" key={`${skill.scope}:${skill.name}`}><div><strong>{skill.name}</strong><span>{skill.description}</span></div><div className="advanced-meta"><span>{skill.scope}</span><code>/skill:{skill.name}</code></div></article>)}</div></section>;
}

function McpPanel({ onError, onSettingsChange }: Pick<AdvancedSettingsProps, "onError" | "onSettingsChange">): React.JSX.Element {
	const [servers, setServers] = useState<readonly McpServerSummary[]>([]);
	const [serverId, setServerId] = useState("");
	const [command, setCommand] = useState("");
	const [scope, setScope] = useState<"project" | "local" | "user">("project");
	const refresh = (): void => { void loadMcpServers().then(setServers).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to load MCP servers.")); };
	useEffect(refresh, [onError]);
	const add = async (): Promise<void> => { try { await callRpc("configure_mcp_server", { serverId, scope, config: { type: "stdio", command, args: [] } }); setServerId(""); setCommand(""); refresh(); await onSettingsChange(); } catch (cause) { onError(cause instanceof Error ? cause.message : "MCP configuration failed."); } };
	return <section className="settings-section"><h3>MCP servers</h3><p className="settings-section-note">Connections are external processes or services. Calls are cancellable and server output remains untrusted.</p><div className="advanced-list">{servers.length === 0 ? <p className="readonly-note">No configured servers.</p> : servers.map((server) => <article className="advanced-row" key={`${server.scope}:${server.id}`}><div><strong>{server.id}</strong><span>{server.state} · {server.tools} tools · {server.resources} resources</span></div><div className="advanced-actions"><button type="button" onClick={() => { void callRpc("reconnect_mcp_server", { serverId: server.id }).then(refresh).catch((cause) => onError(cause instanceof Error ? cause.message : "MCP reconnect failed.")); }}>Reconnect</button><button type="button" onClick={() => { void callRpc("remove_mcp_server", { serverId: server.id, scope: server.scope ?? "project" }).then(refresh).catch((cause) => onError(cause instanceof Error ? cause.message : "MCP remove failed.")); }}>Remove</button></div></article>)}</div><div className="inline-form"><input aria-label="MCP server id" placeholder="server-id" value={serverId} onChange={(event) => setServerId(event.target.value)} /><input aria-label="MCP command" placeholder="command" value={command} onChange={(event) => setCommand(event.target.value)} /><select aria-label="MCP scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">Project</option><option value="local">Local</option><option value="user">User</option></select><button type="button" disabled={!serverId.trim() || !command.trim()} onClick={() => void add()}>Add stdio</button></div></section>;
}

function PluginsPanel({ onError }: Pick<AdvancedSettingsProps, "onError">): React.JSX.Element {
	const [plugins, setPlugins] = useState<readonly PluginSummary[]>([]);
	const refresh = (): void => { void loadPlugins().then(setPlugins).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to load plugins.")); };
	useEffect(refresh, [onError]);
	return <section className="settings-section"><h3>Plugins</h3><p className="settings-section-note">Plugins run in-process. Permissions describe impact and audit scope; they are not an operating-system sandbox.</p><div className="advanced-list">{plugins.length === 0 ? <p className="readonly-note">No managed plugins installed.</p> : plugins.map((plugin) => <article className="advanced-row" key={plugin.id}><div><strong>{plugin.id}</strong><span>v{plugin.version} · {plugin.capabilities.join(", ") || "no declared capabilities"}</span></div><label className="switch"><input type="checkbox" checked={plugin.enabled} onChange={(event) => { void setPluginEnabled(plugin.id, event.target.checked).then(refresh).then(() => window.dispatchEvent(new Event("di-code-web-contributions-changed"))).catch((cause) => onError(cause instanceof Error ? cause.message : "Plugin update failed.")); }} /><span>Enabled</span></label></article>)}</div></section>;
}

function PresetsPanel({ settings, onError, onSettingsChange }: Pick<AdvancedSettingsProps, "settings" | "onError" | "onSettingsChange">): React.JSX.Element {
	const [presets, setPresets] = useState<readonly Preset[]>(() => { try { return JSON.parse(localStorage.getItem("di-code-presets") ?? "[]") as Preset[]; } catch { return []; } });
	const [name, setName] = useState("");
	const save = (): void => { if (!name.trim()) return; const next = [...presets, { id: crypto.randomUUID(), name: name.trim(), providerId: settings.defaults.providerId, modelId: settings.defaults.modelId, thinkingLevel: settings.runtime.thinkingLevel, permissionMode: settings.permissionMode }]; setPresets(next); localStorage.setItem("di-code-presets", JSON.stringify(next)); setName(""); };
	const apply = async (preset: Preset): Promise<void> => { try { if (preset.providerId) await callRpc("set_default_provider", { providerId: preset.providerId }); if (preset.modelId) await callRpc("set_default_model", { modelId: preset.modelId }); if (preset.permissionMode) await callRpc("set_permission_mode", { permissionMode: preset.permissionMode }); if (preset.thinkingLevel) await callRpc("set_thinking_level", { level: preset.thinkingLevel }); await onSettingsChange(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Preset apply failed."); } };
	return <section className="settings-section"><h3>Agent presets</h3><p className="settings-section-note">Presets store non-secret defaults in this browser. Applying one uses explicit settings RPCs; API keys never enter the preset.</p><div className="advanced-list">{presets.map((preset) => <article className="advanced-row" key={preset.id}><div><strong>{preset.name}</strong><span>{preset.providerId ?? "default"} / {preset.modelId ?? "default"}</span></div><div className="advanced-actions"><button type="button" onClick={() => void apply(preset)}>Apply</button><button type="button" onClick={() => { const next = presets.filter((item) => item.id !== preset.id); setPresets(next); localStorage.setItem("di-code-presets", JSON.stringify(next)); }}>Delete</button></div></article>)}</div><div className="inline-form"><input aria-label="Preset name" placeholder="Preset name" value={name} onChange={(event) => setName(event.target.value)} /><button type="button" disabled={!name.trim()} onClick={save}>Save current</button></div></section>;
}

function TrustPanel({ settings, onError, onSettingsChange }: Pick<AdvancedSettingsProps, "settings" | "onError" | "onSettingsChange">): React.JSX.Element {
	const [trusted, setTrusted] = useState<boolean>();
	useEffect(() => { void callRpc<{ readonly trusted: boolean }>("get_project_trust").then((result) => setTrusted(result.trusted)).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to read Workspace trust.")); }, [onError]);
	const update = async (value: boolean): Promise<void> => { try { setTrusted(await setProjectTrust(value)); await onSettingsChange(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Workspace trust update failed."); } };
	return <section className="settings-section"><h3>Workspace trust</h3><p className="settings-section-note">Trust controls project-local Skills, MCP configuration, and project composition loading. It does not grant plugin permissions or create a process sandbox.</p><div className="trust-impact"><strong>{trusted ? "Trusted Workspace" : "Untrusted Workspace"}</strong><span>{trusted ? "Project Skills, MCP, and composition entries may load after validation." : "Only user-scoped resources load; project-local resources remain skipped."}</span><small>Workspace path and secrets stay server-side.</small></div><button className="trust-toggle" type="button" onClick={() => void update(!trusted)}>{trusted ? "Revoke trust" : "Trust this Workspace"}</button><p className="readonly-note">Settings source: {settings.sources.provider}; permission mode: {settings.permissionMode}.</p></section>;
}

function ShortcutsPanel(): React.JSX.Element {
	return <section className="settings-section"><h3>Shortcuts</h3><p className="settings-section-note">Keyboard actions are presentation-only and never bypass RPC authorization or approvals.</p><div className="shortcut-list"><span><kbd>Enter</kbd> Send</span><span><kbd>Shift+Enter</kbd> New line</span><span><kbd>Esc</kbd> Cancel active response</span><span><kbd>Ctrl/⌘ K</kbd> New session</span><span><kbd>Ctrl/⌘ ,</kbd> Settings</span></div></section>;
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
