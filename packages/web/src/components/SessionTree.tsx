import { GitBranch, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { SessionSummary } from "../types.ts";

interface SessionTreeProps {
	readonly sessions: readonly SessionSummary[];
	readonly activeSessionId?: string;
	readonly onOpen: (id: string) => void;
	readonly onRename: (id: string, label: string) => Promise<void>;
	readonly onDelete: (id: string) => Promise<void>;
	readonly onBranch: (id: string) => Promise<void>;
	readonly onInspect: (id: string) => Promise<unknown>;
}

export function SessionTree({ sessions, activeSessionId, onOpen, onRename, onDelete, onBranch, onInspect }: SessionTreeProps): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<"all" | "active">("all");
	const [editing, setEditing] = useState<string>();
	const [label, setLabel] = useState("");
	const [inspect, setInspect] = useState<unknown>();
	const visible = useMemo(() => sessions.filter((s) => (!query || s.label.toLowerCase().includes(query.toLowerCase())) && (filter === "all" || s.id === activeSessionId)), [sessions, query, filter, activeSessionId]);
	return <>
		<label className="session-search"><input aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
		<div className="session-filters"><button type="button" className={filter === "all" ? "is-selected" : ""} onClick={() => setFilter("all")}>All</button><button type="button" className={filter === "active" ? "is-selected" : ""} onClick={() => setFilter("active")}>Active</button></div>
		<div className="session-tree" role="list" aria-label="Sessions">
			{visible.map((session) => <div className={`session-item-wrap${session.id === activeSessionId ? " is-active" : ""}`} key={session.id}>
				{editing === session.id ? <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { void onRename(session.id, label).finally(() => setEditing(undefined)); } if (e.key === "Escape") setEditing(undefined); }} /> : <button className="session-item" type="button" onClick={() => onOpen(session.id)}><MessageSquare size={15} /><span>{session.label || "Untitled session"}</span></button>}
				<div className="session-item-actions"><button type="button" title="Rename" onClick={() => { setEditing(session.id); setLabel(session.label); }}><Pencil size={13} /></button><button type="button" title="Branch" onClick={() => void onBranch(session.id)}><GitBranch size={13} /></button><button type="button" title="Inspect" onClick={() => void onInspect(session.id).then(setInspect)}><span>i</span></button><button type="button" title="Delete" onClick={() => { if (window.confirm("Delete this session?")) void onDelete(session.id); }}><Trash2 size={13} /></button></div>
			</div>)}
		</div>
		{inspect ? <div className="session-inspect" role="dialog"><pre>{JSON.stringify(inspect, null, 2)}</pre><button type="button" onClick={() => setInspect(undefined)}>Close</button></div> : null}
	</>;
}
