import { ArrowUp, CornerDownRight, Paperclip, Square, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import type { AttachmentInfo } from "../types.ts";
import { AttachmentTray } from "./AttachmentTray.tsx";

interface ComposerProps {
	readonly disabled?: boolean;
	readonly busy: boolean;
	readonly attachments: readonly AttachmentInfo[];
	readonly onAddFiles: (files: FileList) => Promise<void>;
	readonly onRemoveAttachment: (id: string) => void;
	readonly onSend: (text: string) => Promise<void>;
	readonly onSteer: (text: string) => Promise<void>;
	readonly onCancel: () => Promise<void>;
}

export function Composer({ disabled = false, busy, attachments, onAddFiles, onRemoveAttachment, onSend, onSteer, onCancel }: ComposerProps): React.JSX.Element {
	const [text, setText] = useState("");
	const [composing, setComposing] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const submit = async (): Promise<void> => {
		const value = text.trim();
		if (!value) return;
		if (busy) await onSteer(value); else await onSend(value);
		setText("");
	};
	return <div className="composer-wrap"><div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void onAddFiles(event.dataTransfer.files); }}><AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} /><textarea aria-label="Message di-code" placeholder={busy ? "Steer di-code while it works" : "Message di-code"} rows={1} disabled={disabled} value={text} onChange={(event) => setText(event.target.value)} onPaste={(event) => { if (event.clipboardData.files.length) void onAddFiles(event.clipboardData.files); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing) { event.preventDefault(); void submit(); } }} /><input className="attachment-input" ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { if (event.currentTarget.files) void onAddFiles(event.currentTarget.files); event.currentTarget.value = ""; }} /><div className="composer-toolbar"><button className="composer-tool" type="button" aria-label="Add attachment" title="Add attachment" onClick={() => input.current?.click()} disabled={disabled || attachments.length >= 4}><Paperclip size={17} /></button><span className="composer-spacer" /><button className="model-select" type="button"><SlidersHorizontal size={15} />Session runtime</button>{busy ? <button className="send-button cancel-button" type="button" aria-label="Cancel response" title="Cancel response" onClick={() => void onCancel()}><Square size={14} /></button> : <button className="send-button" type="button" aria-label="Send message" title="Send message" disabled={disabled || !text.trim()} onClick={() => void submit()}>{busy ? <CornerDownRight size={18} /> : <ArrowUp size={18} />}</button>}</div></div><p className="composer-note">Session messages and accepted attachments are retained in the local session history.</p></div>;
}
