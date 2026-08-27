import { Check, ChevronDown, CircleAlert, Clock3, LoaderCircle, X } from "lucide-react";
import type { ToolTrace } from "../types.ts";

function displayArguments(args: Record<string, unknown>): string {
	return JSON.stringify(args, null, 2);
}

export function ToolCard({ tool }: { readonly tool: ToolTrace }): React.JSX.Element {
	const icon = tool.status === "loading" ? <LoaderCircle className="spin" size={15} /> : tool.status === "success" ? <Check size={15} /> : tool.status === "timeout" ? <Clock3 size={15} /> : tool.status === "cancelled" ? <X size={15} /> : <CircleAlert size={15} />;
	const label = tool.status === "loading" ? "Running" : tool.status === "success" ? "Completed" : tool.status[0]?.toUpperCase() + tool.status.slice(1);
	return <article className={`tool-card tool-${tool.status}`} aria-label={`${tool.name} tool ${label}`}>
		<header className="tool-card-header"><span className="tool-icon">{icon}</span><strong>{tool.name}</strong><span className="tool-status">{label}</span></header>
		<details className="tool-card-details"><summary><ChevronDown size={14} />Details</summary><pre>{displayArguments(tool.arguments)}</pre></details>
		{tool.output ? <details className="tool-output"><summary><ChevronDown size={14} />Output{tool.status === "truncated" ? " (truncated)" : ""}</summary><pre>{tool.output}</pre></details> : null}
		{tool.images?.length ? <div className="tool-images" aria-label="Tool images">{tool.images.map((image, index) => <img key={`${image.src.slice(-32)}-${index}`} src={image.src} alt={image.alt} />)}</div> : null}
		{typeof tool.details?.diff === "string" || typeof tool.details?.patch === "string" ? <details className="tool-diff"><summary><ChevronDown size={14} />Diff</summary><pre>{String(tool.details.diff ?? tool.details.patch)}</pre></details> : null}
	</article>;
}
