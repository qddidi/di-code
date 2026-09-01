import { X } from "lucide-react";
import { useEffect } from "react";

export function Toast({ message, onClose }: { readonly message?: string; readonly onClose: () => void }): React.JSX.Element | null {
	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(onClose, 3_000);
		return () => window.clearTimeout(timer);
	}, [message, onClose]);
	if (!message) return null;
	return <div className="toast toast-error" role="alert"><span>{message}</span><button type="button" aria-label="Dismiss notification" title="Dismiss" onClick={onClose}><X size={15} /></button></div>;
}
