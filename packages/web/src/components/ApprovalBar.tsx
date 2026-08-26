import { Check, ShieldAlert, X } from "lucide-react";
import type { ToolApproval } from "../types.ts";

export function ApprovalBar({ approvals, onApprove }: { readonly approvals: readonly ToolApproval[]; readonly onApprove: (id: string, approved: boolean) => void }): React.JSX.Element | null {
	const pending = approvals.filter((approval) => approval.state === "pending");
	if (!pending.length) return null;
	return <section className="approval-bar" aria-label="Tool approvals">{pending.map((approval) => <div className="approval-item" key={approval.approvalId}><ShieldAlert size={16} /><span>Allow {approval.toolName ?? "this tool"} to run?</span><button type="button" onClick={() => onApprove(approval.approvalId, true)}><Check size={14} />Accept</button><button type="button" onClick={() => onApprove(approval.approvalId, false)}><X size={14} />Deny</button><code>{approval.approvalId.slice(0, 8)}</code></div>)}</section>;
}
