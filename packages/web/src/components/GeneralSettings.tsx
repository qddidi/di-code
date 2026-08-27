import type { SettingsSnapshot } from "../types.ts";
import { useI18n } from "../i18n.tsx";

export interface GeneralSettingsProps {
	readonly settings: SettingsSnapshot;
	readonly theme: "light" | "dark" | "system";
	readonly onThemeChange: (theme: "light" | "dark" | "system") => void;
	readonly onLocaleChange: (locale: "en" | "zh-CN") => void;
	readonly onPermissionChange: (mode: SettingsSnapshot["permissionMode"]) => void;
	readonly onThinkingChange: (level: string) => void;
}

export function GeneralSettings({ settings, theme, onThemeChange, onLocaleChange, onPermissionChange, onThinkingChange }: GeneralSettingsProps): React.JSX.Element {
	const { t } = useI18n();
	return <div className="settings-section" aria-labelledby="general-title">
		<h3 id="general-title">{t("General")}</h3>
		<p className="settings-section-note">{t("Preferences are shared with the terminal client. The active Session keeps its runtime until it is idle.")}</p>
		<div className="setting-row"><div><strong>{t("Appearance")}</strong><span>{t("Choose the appearance for this browser.")}</span></div><div className="theme-options">{(["light", "dark", "system"] as const).map((value) => <button className={`theme-option${theme === value ? " is-selected" : ""}`} type="button" key={value} onClick={() => onThemeChange(value)}>{t(value[0].toUpperCase() + value.slice(1))}</button>)}</div></div>
		<label className="setting-row"><span><strong>{t("Language")}</strong><small>{t("Terminal and WebUI locale")}</small></span><select value={settings.locale ?? "en"} onChange={(event) => onLocaleChange(event.target.value as "en" | "zh-CN")}><option value="en">English</option><option value="zh-CN">{t("中文")}</option></select></label>
		<label className="setting-row"><span><strong>{t("Permission mode")}</strong><small>{t("Default for future turns")}</small></span><select value={settings.permissionMode} onChange={(event) => onPermissionChange(event.target.value as SettingsSnapshot["permissionMode"])}><option value="ask">{t("Ask before tools")}</option><option value="allow">{t("Allow tools")}</option><option value="deny">{t("Deny tools")}</option></select></label>
		<label className="setting-row"><span><strong>{t("Thinking")}</strong><small>{t("Current Session runtime level")}</small></span><select value={settings.runtime.thinkingLevel ?? "default"} onChange={(event) => onThinkingChange(event.target.value)}><option value="default">{t("Default")}</option><option value="low">{t("Low")}</option><option value="medium">{t("Medium")}</option><option value="high">{t("High")}</option><option value="max">{t("Max")}</option></select></label>
		<div className="setting-row"><span><strong>{t("Configuration source")}</strong><small>{t("Environment-managed values are read-only.")}</small></span><code>{settings.sources.provider === "environment" ? t("Environment + settings") : "~/.di-code/settings.json"}</code></div>
	</div>;
}
