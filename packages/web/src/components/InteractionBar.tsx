import { Check, MessageCircleQuestion, X } from "lucide-react";

export interface PendingInteraction {
	readonly requestId: string;
	readonly kind: string;
	readonly prompt: string;
	readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export function InteractionBar({ interactions, onRespond }: { readonly interactions: readonly PendingInteraction[]; readonly onRespond: (requestId: string, result: { readonly status: "answered" | "cancelled"; readonly value?: string; readonly approved?: boolean }) => Promise<void> }): React.JSX.Element | null {
	if (!interactions.length) return null;
	return <section className="interaction-bar" aria-label="Pending interaction">{interactions.map((item) => <div className="interaction-item" key={item.requestId}><MessageCircleQuestion size={16} aria-hidden="true" /><strong>{item.prompt}</strong><div className="interaction-actions">{item.kind === "approval" ? <><button type="button" onClick={() => void onRespond(item.requestId, { status: "answered", approved: true })}><Check size={14} />Approve</button><button type="button" onClick={() => void onRespond(item.requestId, { status: "answered", approved: false })}><X size={14} />Deny</button></> : (item.options ?? []).map((option) => <button type="button" key={option.value} onClick={() => void onRespond(item.requestId, { status: "answered", value: option.value })}>{option.label}</button>)}<button type="button" aria-label="Cancel interaction" onClick={() => void onRespond(item.requestId, { status: "cancelled" })}><X size={14} /></button></div></div>)}</section>;
}
