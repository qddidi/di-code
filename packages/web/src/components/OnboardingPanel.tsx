import { useState } from "react";
import { callRpc } from "../api.ts";
import type { SettingsSnapshot } from "../types.ts";

export function OnboardingPanel({ settings, onComplete }: { readonly settings: SettingsSnapshot; readonly onComplete: () => void }): React.JSX.Element {
	const [providerId, setProviderId] = useState(settings.providers[0]?.id ?? "");
	const [apiKey, setApiKey] = useState("");
	const provider = settings.providers.find((item) => item.id === providerId);
	const submit = async (): Promise<void> => { if (!provider || !apiKey.trim()) return; await callRpc("login", { providerId, apiKey, modelId: provider.models[0]?.id }); onComplete(); };
	return <div className="overlay"><section className="onboarding-panel" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><p className="eyebrow">Welcome to di-code</p><h2 id="onboarding-title">Connect a Provider</h2><p>Use your existing environment settings or add a credential for this device.</p><label>Provider<select value={providerId} onChange={(event) => setProviderId(event.target.value)}>{settings.providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{provider?.apiKeySource === "environment" ? <p className="readonly-note">This Provider is managed by an environment variable.</p> : <label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoFocus /></label>}<button type="button" onClick={() => void submit()} disabled={!provider || provider.apiKeySource === "environment" || !apiKey.trim()}>Continue</button></section></div>;
}
