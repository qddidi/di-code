import { Check, MessageCircleQuestion, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { useI18n } from "../i18n.tsx";

export interface PendingInteraction {
	readonly requestId: string;
	readonly kind: string;
	readonly prompt: string;
	readonly intent?: string;
	readonly options?: readonly { readonly value: string; readonly label: string }[];
	readonly questions?: readonly {
		readonly id: string;
		readonly prompt: string;
		readonly options?: readonly { readonly value: string; readonly label: string }[];
	}[];
}

export function InteractionBar({ interactions, onRespond }: { readonly interactions: readonly PendingInteraction[]; readonly onRespond: (requestId: string, result: { readonly status: "answered" | "cancelled"; readonly value?: string; readonly approved?: boolean }) => Promise<void> }): React.JSX.Element | null {
	const firstRequestId = interactions[0]?.requestId;
	const firstActionRef = useRef<HTMLButtonElement>(null);
	const { t } = useI18n();
	useEffect(() => {
		if (!firstRequestId) return;
		firstActionRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				void onRespond(firstRequestId, { status: "cancelled" });
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [firstRequestId, onRespond]);
	if (!interactions.length) return null;
	return <div className="overlay interaction-overlay" role="presentation"><section className="interaction-panel" role="dialog" aria-modal="true" aria-labelledby="interaction-title"><header className="interaction-header"><MessageCircleQuestion size={20} aria-hidden="true" /><div><p className="eyebrow">{t("Action required")}</p><h2 id="interaction-title">{interactions.some((item) => item.intent === "plan-review") ? t("Plan review") : t("Approval required")}</h2></div></header>{interactions.map((item) => <div className="interaction-item" key={item.requestId}><div className="interaction-copy"><strong>{item.prompt}</strong>{item.questions?.map((question) => <div className="interaction-question" key={question.id}><MarkdownContent>{question.prompt}</MarkdownContent></div>)}</div><div className="interaction-actions">{item.kind === "approval" ? <><button ref={item.requestId === firstRequestId ? firstActionRef : undefined} type="button" onClick={() => void onRespond(item.requestId, { status: "answered", approved: true })}><Check size={14} />{t("Approve")}</button><button type="button" onClick={() => void onRespond(item.requestId, { status: "answered", approved: false })}><X size={14} />{t("Deny")}</button></> : (item.options ?? []).map((option, index) => <button ref={item.requestId === firstRequestId && index === 0 ? firstActionRef : undefined} type="button" key={option.value} onClick={() => void onRespond(item.requestId, { status: "answered", value: option.value })}>{option.label}</button>)}<button type="button" aria-label={t("Cancel interaction")} title={t("Cancel")} onClick={() => void onRespond(item.requestId, { status: "cancelled" })}><X size={14} /></button></div></div>)}</section></div>;
}
