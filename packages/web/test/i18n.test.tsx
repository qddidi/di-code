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
		expect(html).toContain("让想法落地成代码");
		expect(html).toContain("今天我们要构建什么？");
		expect(html).toContain("工作区");
		expect(html).not.toContain("What are we building today?");
	});

	it("renders the brand tagline in English by default", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><EmptyState /></I18nProvider>);
		expect(html).toContain("Turn ideas into code.");
		expect(html).not.toContain("探索未至之境");
	});

	it("shows the active workspace name on the empty conversation screen", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN"><EmptyState workspaceName="di-code" /></I18nProvider>);
		expect(html).toContain(">di-code</span>");
	});

	it("labels the language option as 中文", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN"><GeneralSettings settings={settings} theme="system" onThemeChange={() => undefined} onLocaleChange={() => undefined} onPermissionChange={() => undefined} onThinkingChange={() => undefined} /></I18nProvider>);
		expect(html).toContain(">中文</option>");
		expect(html).not.toContain("简体中文");
	});

	it("uses the updated Chinese permission mode labels", () => {
		const html = renderToStaticMarkup(<I18nProvider initialLocale="zh-CN"><GeneralSettings settings={settings} theme="system" onThemeChange={() => undefined} onLocaleChange={() => undefined} onPermissionChange={() => undefined} onThinkingChange={() => undefined} /></I18nProvider>);
		expect(html).toContain(">请求批准</option>");
		expect(html).toContain(">完全访问</option>");
		expect(html).toContain(">禁止访问</option>");
	});

	it("uses the active model's declared reasoning efforts", () => {
		const glmSettings = {
			...settings,
			providers: [{
				id: "zhipu",
				name: "Zhipu",
				configured: true,
				api: "openai-chat-completions",
				apiKeySource: "settings",
				models: [{ id: "glm-5", name: "GLM-5", input: ["text"], reasoningEfforts: ["low", "high", "max"] }],
			}],
			runtime: { providerId: "zhipu", modelId: "glm-5", thinkingLevel: "high" },
		} satisfies SettingsSnapshot;
		const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><GeneralSettings settings={glmSettings} theme="system" onThemeChange={() => undefined} onLocaleChange={() => undefined} onPermissionChange={() => undefined} onThinkingChange={() => undefined} /></I18nProvider>);
		expect(html).toContain('<option value="low">Low</option>');
		expect(html).toContain('<option value="high" selected="">High</option>');
		expect(html).toContain('<option value="max">Max</option>');
		expect(html).not.toContain('<option value="medium">Medium</option>');
	});
});
