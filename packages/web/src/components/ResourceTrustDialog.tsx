import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { loadProjectResourceSummary, setProjectTrust } from "../api.ts";
import { useI18n } from "../i18n.tsx";

export function ResourceTrustDialog({ onComplete }: { readonly onComplete: () => void }): React.JSX.Element | null {
	const [loading, setLoading] = useState(true);
	const [visible, setVisible] = useState(false);
	const [error, setError] = useState<string>();
	const [inspectionFailed, setInspectionFailed] = useState(false);
	const [choosing, setChoosing] = useState(false);
	const { t } = useI18n();
	useEffect(() => {
		void loadProjectResourceSummary()
			.then((result) => setVisible(!result.projectTrusted && result.hasProjectResources))
			.catch((cause) => {
				setVisible(true);
				setInspectionFailed(true);
				setError(cause instanceof Error ? cause.message : t("Unable to inspect project resources."));
			})
			.finally(() => setLoading(false));
	}, []);
	if (loading || !visible) return null;
	const choose = async (trusted: boolean): Promise<void> => {
		if (choosing) return;
		setChoosing(true);
		setError(undefined);
		try {
			await setProjectTrust(trusted);
			onComplete();
		} catch (cause) {
			setChoosing(false);
			setError(cause instanceof Error ? cause.message : t("Unable to update project trust."));
		}
	};
	return <div className="overlay resource-trust-overlay"><section className="onboarding-panel resource-trust-panel" role="dialog" aria-modal="true" aria-labelledby="resource-trust-title"><p className="eyebrow">{t("Project resources detected")}</p><h2 id="resource-trust-title">{t("Load project plugins and integrations?")}</h2><p>{t("Plugins, Skills, and MCP configuration come from this workspace. Review them before allowing project-local code and instructions to load.")}</p>{error ? <p className="settings-error" role="alert">{error}</p> : null}<div className="resource-trust-actions">{inspectionFailed ? <button type="button" onClick={onComplete}>{t("Close")}</button> : <><button type="button" className="button-quiet" disabled={choosing} aria-busy={choosing} onClick={() => void choose(false)}>{choosing ? <><LoaderCircle className="spin" size={13} />{t("Loading...")}</> : t("Not now")}</button><button type="button" disabled={choosing} aria-busy={choosing} onClick={() => void choose(true)}>{choosing ? <><LoaderCircle className="spin" size={13} />{t("Loading...")}</> : t("Trust and load")}</button></>}</div></section></div>;
}
