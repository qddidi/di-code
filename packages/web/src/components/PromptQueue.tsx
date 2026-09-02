import { ListOrdered, MessageCircleMore } from "lucide-react";
import { useI18n } from "../i18n.tsx";

export function PromptQueue({ queuedPrompts, steeringPrompts, busy = false }: { readonly queuedPrompts: readonly string[]; readonly steeringPrompts: readonly string[]; readonly busy?: boolean }): React.JSX.Element | null {
	const { t } = useI18n();
	if (!busy && !queuedPrompts.length && !steeringPrompts.length) return null;
	return <section className="prompt-queue" aria-label={t("Prompt queue")} aria-live="polite">
		{queuedPrompts.length ? <div className="prompt-queue-group"><div className="prompt-queue-heading"><ListOrdered size={14} aria-hidden="true" /><strong>{t("Queued messages")}</strong><span>{queuedPrompts.length}</span></div><ol>{queuedPrompts.map((prompt, index) => <li key={`${prompt}-${index}`}>{prompt}</li>)}</ol></div> : null}
		{busy || steeringPrompts.length ? <div className="prompt-queue-group prompt-steering"><div className="prompt-queue-heading"><MessageCircleMore size={14} aria-hidden="true" /><strong>{t("Steering")}</strong><span>{steeringPrompts.length}</span></div>{steeringPrompts.length ? <ol>{steeringPrompts.map((prompt, index) => <li key={`${prompt}-${index}`}>{prompt}</li>)}</ol> : <p className="prompt-queue-empty">{t("Use Alt+S to guide the active response.")}</p>}</div> : null}
	</section>;
}
