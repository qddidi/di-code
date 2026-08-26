import { ImageIcon, X } from "lucide-react";
import type { AttachmentInfo } from "../types.ts";

export function AttachmentTray({ attachments, onRemove }: { readonly attachments: readonly AttachmentInfo[]; readonly onRemove: (id: string) => void }): React.JSX.Element | null {
	if (attachments.length === 0) return null;
	return <div className="attachment-tray" aria-label="Attachments">
		{attachments.map((attachment) => <div className="attachment-chip" key={attachment.id}>{attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <ImageIcon size={14} />}<span title={attachment.name}>{attachment.name}</span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}><X size={14} /></button></div>)}
	</div>;
}
