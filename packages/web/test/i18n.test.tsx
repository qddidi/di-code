import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../src/components/EmptyState.tsx";
import { GeneralSettings } from "../src/components/GeneralSettings.tsx";
import { I18nProvider } from "../src/i18n.tsx";
import type { SettingsSnapshot } from "../src/types.ts";

const settings = {
	providers: [],
	defaults: {},
	runtime: { providerId: "faux", modelId: "faux-model" },
	locale: "zh-CN",
	permissionMode: "ask",
	sources: { provider: "settings", model: "settings", locale: "settings", permissionMode: "default", runtime: "runtime" },
} satisfies SettingsSnapshot;

describe("web locale", () => {
	it("renders Chinese when the persisted zh-CN locale is active", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN"><EmptyState /></I18nProvider>);
		expect(html).toContain("今天我们要构建什么？");
		expect(html).toContain("工作区");
		expect(html).not.toContain("What are we building today?");
	});

	it("labels the language option as 中文", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN"><GeneralSettings settings={settings} theme="system" onThemeChange={() => undefined} onLocaleChange={() => undefined} onPermissionChange={() => undefined} onThinkingChange={() => undefined} /></I18nProvider>);
		expect(html).toContain(">中文</option>");
		expect(html).not.toContain("简体中文");
	});
});
