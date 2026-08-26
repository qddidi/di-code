import { X } from "lucide-react";

export function Toast({ message, onClose }: { readonly message?: string; readonly onClose: () => void }): React.JSX.Element | null {
	if (!message) return null;
	return <div className="toast toast-error" role="alert"><span>{message}</span><button type="button" aria-label="Dismiss notification" title="Dismiss" onClick={onClose}><X size={15} /></button></div>;
}
