import { Activity, Archive, Ban, RotateCcw } from "lucide-react";
import type { OperationState, UsageSnapshot } from "../types.ts";

interface RuntimeControlsProps {
	readonly operation?: OperationState;
	readonly usage?: UsageSnapshot;
	readonly onCancel: () => void;
	readonly onRetry: () => void;
	readonly onCompact: () => void;
}

export function RuntimeControls({ operation, usage, onCancel, onRetry, onCompact }: RuntimeControlsProps): React.JSX.Element {
	const active = operation?.status === "queued" || operation?.status === "running";
	const retryable = operation?.status === "failed" || operation?.status === "cancelled";
	return <footer className="runtime-controls" aria-live="polite">
		<div className="usage"><Activity size={14} />{usage?.requestCount ?? 0} requests <span>{usage?.inputTokens ?? 0} in</span><span>{usage?.outputTokens ?? 0} out</span></div>
		{active ? <button className="runtime-action danger" type="button" onClick={onCancel}><Ban size={14} />Cancel</button> : null}
		{!active ? <button className="runtime-action" type="button" onClick={onCompact}><Archive size={14} />Compact context</button> : null}
		{retryable ? <button className="runtime-action" type="button" onClick={onRetry}><RotateCcw size={14} />Retry</button> : null}
		{operation?.error ? <span className="runtime-error">{operation.error.message}</span> : null}
	</footer>;
}
