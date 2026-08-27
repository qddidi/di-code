import { Code2, Folder, Sparkles } from "lucide-react";
import { useI18n } from "../i18n.tsx";

export function EmptyState({ workspaceName }: { readonly workspaceName?: string }): React.JSX.Element {
	const { t } = useI18n();
	return <section className="empty-state" aria-labelledby="empty-title">
		<div className="empty-brand"><Sparkles size={22} /><span>{t("Turn ideas into code.")}</span><small>预览版</small></div>
		<h1 id="empty-title">{t("What are we building today?")}</h1>
		<p>{t("Ask di-code to explore your workspace, write code, or solve a problem.")}</p>
		<div className="hero-picker-row" aria-label={t("Current workspace and mode")}><span className="hero-picker"><Folder size={15} />{workspaceName ?? t("Workspace")}</span><span className="hero-picker"><Code2 size={15} />{t("Standard session")}</span></div>
	</section>;
}
