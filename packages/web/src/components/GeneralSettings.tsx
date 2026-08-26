import type { SettingsSnapshot } from "../types.ts";

export interface GeneralSettingsProps {
	readonly settings: SettingsSnapshot;
	readonly theme: "light" | "dark" | "system";
	readonly onThemeChange: (theme: "light" | "dark" | "system") => void;
	readonly onLocaleChange: (locale: "en" | "zh-CN") => void;
	readonly onPermissionChange: (mode: SettingsSnapshot["permissionMode"]) => void;
	readonly onThinkingChange: (level: string) => void;
}

export function GeneralSettings({ settings, theme, onThemeChange, onLocaleChange, onPermissionChange, onThinkingChange }: GeneralSettingsProps): React.JSX.Element {
	return <div className="settings-section" aria-labelledby="general-title">
		<h3 id="general-title">General</h3>
		<p className="settings-section-note">Preferences are shared with the terminal client. The active Session keeps its runtime until it is idle.</p>
		<div className="setting-row"><div><strong>Appearance</strong><span>Choose the appearance for this browser.</span></div><div className="theme-options">{(["light", "dark", "system"] as const).map((value) => <button className={`theme-option${theme === value ? " is-selected" : ""}`} type="button" key={value} onClick={() => onThemeChange(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div></div>
		<label className="setting-row"><span><strong>Language</strong><small>Terminal and WebUI locale</small></span><select value={settings.locale ?? "en"} onChange={(event) => onLocaleChange(event.target.value as "en" | "zh-CN")}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
		<label className="setting-row"><span><strong>Permission mode</strong><small>Default for future turns</small></span><select value={settings.permissionMode} onChange={(event) => onPermissionChange(event.target.value as SettingsSnapshot["permissionMode"])}><option value="ask">Ask before tools</option><option value="allow">Allow tools</option><option value="deny">Deny tools</option></select></label>
		<label className="setting-row"><span><strong>Thinking</strong><small>Current Session runtime level</small></span><select value={settings.runtime.thinkingLevel ?? "default"} onChange={(event) => onThinkingChange(event.target.value)}><option value="default">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select></label>
		<div className="setting-row"><span><strong>Configuration source</strong><small>Environment-managed values are read-only.</small></span><code>{settings.sources.provider === "environment" ? "Environment + settings" : "~/.di-code/settings.json"}</code></div>
	</div>;
}
