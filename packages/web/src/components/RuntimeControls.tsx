import { Ban } from "lucide-react";
import type { OperationState } from "../types.ts";

interface RuntimeControlsProps {
	readonly operation?: OperationState;
	readonly onCancel: () => void;
}

export function RuntimeControls({ operation, onCancel }: RuntimeControlsProps): React.JSX.Element | null {
	const active = operation?.status === "queued" || operation?.status === "running";
	return active ? <footer className="runtime-controls" aria-live="polite"><button className="runtime-action danger" type="button" onClick={onCancel}><Ban size={14} />Cancel</button></footer> : null;
}
