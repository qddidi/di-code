import { BrainCircuit, RotateCcw } from "lucide-react";
import type { ConversationMessage } from "../types.ts";

interface TranscriptProps {
	readonly messages: readonly ConversationMessage[];
	readonly onRetry: () => void;
	readonly canRetry: boolean;
}

export function Transcript({ messages, onRetry, canRetry }: TranscriptProps): React.JSX.Element {
	if (messages.length === 0) return <section className="conversation-empty" aria-live="polite">Start a session to work with di-code.</section>;
	return <section className="transcript" aria-label="Conversation transcript">
		{messages.map((message, index) => <article className={`message message-${message.role}`} key={`${message.role}-${index}`}>
			<div className="message-label">{message.role === "user" ? "You" : message.role === "assistant" ? "di-code" : "Tool"}</div>
			{message.thinking ? <details className="thinking"><summary><BrainCircuit size={15} />Thinking</summary><pre>{message.thinking}</pre></details> : null}
			{message.text ? <div className="message-body">{message.text}</div> : null}
			{message.status === "streaming" ? <span className="streaming-cursor" aria-label="Streaming response" /> : null}
			{message.role === "assistant" && canRetry && index === messages.length - 1 ? <button className="message-retry" type="button" onClick={onRetry}><RotateCcw size={14} />Retry</button> : null}
		</article>)}
	</section>;
}
