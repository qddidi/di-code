import { Check, Copy, GitBranch, RotateCcw, Wand2 } from "lucide-react";
import { ActivityTimeline } from "./ActivityTimeline.tsx";
import type { ConversationMessage } from "../types.ts";

interface TranscriptProps {
	readonly messages: readonly ConversationMessage[];
	readonly onRetry: () => void;
	readonly canRetry: boolean;
	readonly onBranch: (entryId?: string) => void;
	readonly webSlot?: React.ReactNode;
	readonly waitingForResponse?: boolean;
}

export function Transcript({ messages, onRetry, canRetry, onBranch, webSlot, waitingForResponse = false }: TranscriptProps): React.JSX.Element {
	if (messages.length === 0 && !waitingForResponse) return <section className="conversation-empty" aria-live="polite">Start a session to work with di-code.</section>;
	const copyMessage = (text: string): void => { void navigator.clipboard?.writeText(text); };
	return <section className="transcript" aria-label="Conversation transcript">
		{messages.map((message, index) => <article className={`message message-${message.role}${message.status === "error" ? " message-error" : ""}`} key={`${message.role}-${index}`}>
			<div className="message-label">{message.role === "user" ? "You" : message.role === "assistant" ? "di-code" : "Tool"}</div>
			{message.role === "assistant" ? <ActivityTimeline activities={message.activities} streaming={message.status === "streaming"} /> : null}
			{message.skillName ? <div className="message-skill"><Wand2 size={14} />Used skill <code>/{`skill:${message.skillName}`}</code></div> : null}
			{message.text ? <div className="message-body">{message.text}</div> : null}
			{message.images?.length ? <div className="message-images">{message.images.map((image, imageIndex) => <img key={`${image.src.slice(-32)}-${imageIndex}`} src={image.src} alt={image.alt} />)}</div> : null}
			{message.status === "streaming" && !message.text && !message.activities?.length ? <span className="streaming-status" role="status" aria-label="Streaming response"><span className="streaming-dots"><i /><i /><i /></span></span> : null}
			{message.role === "assistant" && message.status !== "streaming" && message.status !== "error" ? <div className="message-actions"><button type="button" aria-label="Copy" title="Copy" onClick={() => copyMessage(message.text)}><Copy size={15} /></button><button type="button" aria-label="Branch into a new conversation" title="Branch into a new conversation" onClick={() => onBranch(message.entryId)}><GitBranch size={15} /></button><span className="message-complete"><Check size={13} />Completed</span></div> : null}
			{message.role === "assistant" && canRetry && index === messages.length - 1 ? <button className="message-retry" type="button" onClick={onRetry}><RotateCcw size={14} />Retry</button> : null}
			{index === messages.length - 1 ? webSlot : null}
		</article>)}
		{waitingForResponse ? <article className="message message-assistant message-pending"><div className="message-label">di-code</div><span className="streaming-status" role="status" aria-label="Waiting for response"><span className="streaming-dots"><i /><i /><i /></span></span></article> : null}
	</section>;
}
