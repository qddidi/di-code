import { BrainCircuit, Check, CircleAlert, Terminal, Wrench, X } from "lucide-react";
import type { ConversationActivity, ToolTrace } from "../types.ts";

export function LoadingDots({ label = "Working" }: { readonly label?: string }): React.JSX.Element {
	return <span className="streaming-status activity-loading-dots" role="status" aria-label={label}><span className="streaming-dots" aria-hidden="true"><i /><i /><i /></span></span>;
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stringArgument(argumentsValue: Record<string, unknown>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = argumentsValue[name];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function toolSummary(tool: ToolTrace): string {
	const direct = stringArgument(tool.arguments, ["command", "path", "pattern", "query", "filePath"]);
	if (direct) return compactText(direct);
	try {
		return compactText(JSON.stringify(tool.arguments));
	} catch {
		return "Arguments unavailable";
	}
}

function activityLabel(activity: ConversationActivity): string {
	return activity.kind === "thinking" ? "Think" : activity.tool.name;
}

function statusIcon(tool: ToolTrace): React.JSX.Element | null {
	if (tool.status === "loading") return null;
	if (tool.status === "success" || tool.status === "truncated") return <Check size={14} />;
	if (tool.status === "cancelled") return <X size={14} />;
	return <CircleAlert size={14} />;
}

function ActivityLine({ activity, streaming }: { readonly activity: ConversationActivity; readonly streaming: boolean }): React.JSX.Element {
	if (activity.kind === "thinking") {
		const summary = compactText(activity.text);
		if (streaming)
			return <div className="activity-row activity-row-live"><span className="activity-icon"><BrainCircuit size={14} /></span><strong>Think</strong><span className="activity-separator">·</span><span className="activity-summary">{summary || "Thinking..."}</span></div>;
		return <details className="activity-row activity-thinking"><summary><span className="activity-icon"><BrainCircuit size={14} /></span><strong>Think</strong><span className="activity-separator">·</span><span className="activity-summary">{summary}</span></summary><pre>{activity.text}</pre></details>;
	}
	const tool = activity.tool;
	const ToolIcon = tool.name === "bash" ? Terminal : Wrench;
	const status = statusIcon(tool);
	return <div className={`activity-row activity-tool activity-${tool.status}`} aria-label={`${tool.name}: ${tool.status}`}><span className="activity-icon"><ToolIcon size={14} /></span><strong>{activityLabel(activity)}</strong><span className="activity-separator">·</span><span className="activity-summary">{toolSummary(tool)}</span>{status ? <span className="activity-status" title={tool.status}>{status}</span> : null}</div>;
}

export function ActivityTimeline({ activities, streaming }: { readonly activities?: readonly ConversationActivity[]; readonly streaming: boolean }): React.JSX.Element | null {
	const items = activities ?? [];
	if (!items.length) {
		return streaming ? <div className="activity-row activity-row-live"><LoadingDots label="Thinking" /></div> : null;
	}
	return <section className={`activity-timeline${streaming ? " activity-timeline-live" : ""}`} aria-label="Thinking and tool activity" aria-live={streaming ? "polite" : undefined}>{items.map((activity) => <ActivityLine activity={activity} key={activity.id} streaming={streaming} />)}</section>;
}
