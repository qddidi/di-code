import { Check, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { SettingsSnapshot } from "../types.ts";
import { useI18n } from "../i18n.tsx";

type CustomApi = "openai-responses" | "openai-chat-completions" | "anthropic-messages";
const API_KEY_MASK = "••••••••••••••••";

export interface ModelsSettingsProps {
	readonly settings: SettingsSnapshot;
	readonly onRuntimeChange: (providerId: string, modelId: string) => Promise<void>;
	readonly onLogin: (providerId: string, apiKey: string, modelId?: string) => Promise<void>;
	readonly onLogout: (providerId: string) => Promise<void>;
	readonly onCustomProvider: (input: {
		readonly api: CustomApi;
		readonly baseUrl: string;
		readonly apiKey: string;
		readonly modelId: string;
	}) => Promise<void>;
}

function providerStatus(provider: SettingsSnapshot["providers"][number]): string {
	if (provider.apiKeySource === "environment") return "Environment";
	return provider.configured ? "Configured" : "Not configured";
}

export function ModelsSettings({ settings, onRuntimeChange, onLogin, onLogout, onCustomProvider }: ModelsSettingsProps): React.JSX.Element {
	const { t } = useI18n();
	const [selectedId, setSelectedId] = useState(settings.runtime.providerId);
	const [selectedModelId, setSelectedModelId] = useState(settings.runtime.modelId);
	const [providerApiKey, setProviderApiKey] = useState("");
	const [customApiKey, setCustomApiKey] = useState("");
	const [focusedKeyField, setFocusedKeyField] = useState<"provider" | "custom">();
	const [custom, setCustom] = useState<{ api: CustomApi; baseUrl: string; modelId: string }>({
		api: "openai-responses",
		baseUrl: "",
		modelId: "",
	});
	const modelCatalogId = useId();
	const configuredCustom = settings.providers.find((provider) => provider.id === "custom");
	const providers = settings.providers.filter((provider) => provider.id !== "custom");
	const selectedProvider = providers.find((provider) => provider.id === selectedId);
	const customSelected = selectedId === "custom";
	const providerHasStoredKey = selectedProvider?.apiKeySource === "settings";
	const customHasStoredKey = configuredCustom?.apiKeySource === "settings";
	const modelCatalog = useMemo(
		() =>
			Array.from(
				new Map(
					settings.providers.flatMap((provider) =>
						provider.models.map((model) => [model.id, { id: model.id, name: model.name }]),
					),
				).values(),
			).sort((left, right) => left.name.localeCompare(right.name)),
		[settings.providers],
	);

	useEffect(() => {
		setSelectedId(settings.runtime.providerId);
		setSelectedModelId(settings.runtime.modelId);
	}, [settings.runtime.modelId, settings.runtime.providerId]);
	useEffect(() => {
		if (!configuredCustom) return;
		setCustom((current) => ({
			...current,
			api: current.api === "openai-responses" ? (configuredCustom.api as CustomApi) : current.api,
			baseUrl: current.baseUrl || configuredCustom.baseUrl || "",
			modelId:
				current.modelId ||
				configuredCustom.models.find((model) => model.id === settings.runtime.modelId)?.id ||
				configuredCustom.models[0]?.id ||
				"",
		}));
	}, [configuredCustom, settings.runtime.modelId]);

	const selectProvider = (providerId: string): void => {
		setSelectedId(providerId);
		setProviderApiKey("");
		setFocusedKeyField(undefined);
		if (providerId === "custom") {
			const modelId =
				configuredCustom?.models.find((model) => model.id === settings.runtime.modelId)?.id ??
				configuredCustom?.models[0]?.id ??
				"";
			setSelectedModelId(modelId);
			if (modelId) void onRuntimeChange("custom", modelId);
			return;
		}
		const provider = providers.find((item) => item.id === providerId);
		const modelId =
			settings.runtime.providerId === providerId ? settings.runtime.modelId : (provider?.models[0]?.id ?? "");
		setSelectedModelId(modelId);
		if (provider?.configured && modelId) void onRuntimeChange(provider.id, modelId);
	};
	const saveCustom = async (): Promise<void> => {
		const modelId = custom.modelId.trim();
		if (!custom.baseUrl.trim() || !modelId || !customApiKey.trim()) return;
		await onCustomProvider({ ...custom, baseUrl: custom.baseUrl.trim(), modelId, apiKey: customApiKey });
		await onRuntimeChange("custom", modelId);
		setCustomApiKey("");
	};
	const useCustomModel = (): void => {
		const modelId = custom.modelId.trim();
		if (configuredCustom && modelId) void onRuntimeChange("custom", modelId);
	};

	return <div className="settings-section" aria-labelledby="models-title">
		<h3 id="models-title">{t("Models")}</h3>
		<p className="settings-section-note">{t("Credentials never leave the server. Environment-managed credentials cannot be edited here.")}</p>
		<div className="provider-selector" role="radiogroup" aria-label="Provider">
			{providers.map((provider) => <button className={`provider-choice${selectedId === provider.id ? " is-selected" : ""}`} type="button" role="radio" aria-checked={selectedId === provider.id} key={provider.id} onClick={() => selectProvider(provider.id)}><span><strong>{provider.name}</strong><small>{provider.models.length} {t("models")}</small></span><em className={`status-${provider.apiKeySource}`}>{t(providerStatus(provider))}</em>{settings.runtime.providerId === provider.id ? <Check size={15} aria-label={t("Active provider")} /> : null}</button>)}
			<button className={`provider-choice provider-choice-custom${customSelected ? " is-selected" : ""}`} type="button" role="radio" aria-checked={customSelected} onClick={() => selectProvider("custom")}><span><strong>{t("Custom")}</strong><small>{configuredCustom ? `${configuredCustom.models.length} ${t("saved models")}` : t("Configure a gateway")}</small></span><em className={configuredCustom ? `status-${configuredCustom.apiKeySource}` : "status-missing"}>{configuredCustom ? t(providerStatus(configuredCustom)) : t("Not configured")}</em>{settings.runtime.providerId === "custom" ? <Check size={15} aria-label={t("Active provider")} /> : <Plus size={15} aria-hidden="true" />}</button>
		</div>
		{selectedProvider ? <section className="model-controls" aria-labelledby={`${selectedProvider.id}-model-title`}>
			<h4 id={`${selectedProvider.id}-model-title`}>{selectedProvider.name}</h4>
			<label>Model<select value={selectedModelId} onChange={(event) => { setSelectedModelId(event.target.value); void onRuntimeChange(selectedProvider.id, event.target.value); }}><option value="">Select a model</option>{selectedProvider.models.map((model) => <option value={model.id} key={model.id}>{model.name} ({model.id})</option>)}</select></label>
			{selectedProvider.apiKeySource === "environment" ? <p className="readonly-note">API key is managed by the environment: <span className="masked-key-indicator">{API_KEY_MASK}</span></p> : <div className="login-row"><input aria-label={`${selectedProvider.name} API key`} className={providerHasStoredKey && focusedKeyField !== "provider" ? "masked-key" : undefined} type="password" value={providerApiKey} onChange={(event) => setProviderApiKey(event.target.value)} onFocus={() => setFocusedKeyField("provider")} onBlur={() => setFocusedKeyField(undefined)} placeholder={providerHasStoredKey && focusedKeyField !== "provider" ? API_KEY_MASK : "API key"} /><button type="button" onClick={() => void onLogin(selectedProvider.id, providerApiKey, selectedModelId).then(() => setProviderApiKey(""))} disabled={!providerApiKey.trim() || !selectedModelId}>Save key</button>{selectedProvider.configured ? <button type="button" className="button-quiet" onClick={() => void onLogout(selectedProvider.id)}>Log out</button> : null}</div>}
		</section> : null}
		{customSelected ? <section className="custom-provider-form" aria-labelledby="custom-provider-title">
			<div className="custom-provider-heading"><div><h4 id="custom-provider-title">{t("Custom Provider")}</h4><p>{configuredCustom ? t("Update connection") : t("New connection")}</p></div>{configuredCustom ? <button type="button" className="button-quiet" onClick={useCustomModel} disabled={!custom.modelId.trim()}>{t("Use model")}</button> : null}</div>
			<div className="custom-provider-grid">
				<label>API<select aria-label="Custom Provider API" value={custom.api} onChange={(event) => setCustom({ ...custom, api: event.target.value as CustomApi })}><option value="openai-responses">OpenAI Responses</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
				<label>Model ID<input aria-label="Custom Provider model" list={modelCatalogId} placeholder="Choose or enter a model ID" value={custom.modelId} onChange={(event) => setCustom({ ...custom, modelId: event.target.value })} /></label>
				<label className="custom-provider-wide">Base URL<input aria-label="Custom Provider Base URL" placeholder="https://gateway.example/v1" value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })} /></label>
				<label className="custom-provider-wide">API key<input aria-label="Custom Provider API key" className={customHasStoredKey && focusedKeyField !== "custom" ? "masked-key" : undefined} type="password" placeholder={customHasStoredKey && focusedKeyField !== "custom" ? API_KEY_MASK : "API key"} value={customApiKey} onChange={(event) => setCustomApiKey(event.target.value)} onFocus={() => setFocusedKeyField("custom")} onBlur={() => setFocusedKeyField(undefined)} /></label>
			</div>
			<datalist id={modelCatalogId}>{modelCatalog.map((model) => <option value={model.id} label={model.name} key={model.id} />)}</datalist>
			<button type="button" className="custom-save" disabled={!custom.baseUrl.trim() || !custom.modelId.trim() || !customApiKey.trim()} onClick={() => void saveCustom()}>{configuredCustom ? t("Save custom provider") : t("Add custom provider")}</button>
		</section> : null}
	</div>;
}
