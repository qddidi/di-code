import { GitBranch, MessageSquare, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
	const [menu, setMenu] = useState<string>();
	useEffect(() => {
		if (!menu && !inspect) return;
		const closeOnOutsidePointer = (event: PointerEvent): void => {
			if (event.target instanceof Element && !event.target.closest(".session-item-wrap, .session-inspect")) {
				setMenu(undefined);
				setInspect(undefined);
			}
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setMenu(undefined);
				setInspect(undefined);
			}
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [menu, inspect]);
	const visible = useMemo(() => sessions.filter((s) => (!query || s.label.toLowerCase().includes(query.toLowerCase())) && (filter === "all" || s.id === activeSessionId)), [sessions, query, filter, activeSessionId]);
	return <>
		<label className="session-search"><input aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
		<div className="session-filters"><button type="button" className={filter === "all" ? "is-selected" : ""} onClick={() => setFilter("all")}>All</button><button type="button" className={filter === "active" ? "is-selected" : ""} onClick={() => setFilter("active")}>Active</button></div>
		<div className="session-tree" role="list" aria-label="Sessions">
			{visible.map((session) => <div className={`session-item-wrap${session.id === activeSessionId ? " is-active" : ""}`} key={session.id}>
				{editing === session.id ? <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { void onRename(session.id, label).finally(() => setEditing(undefined)); } if (e.key === "Escape") setEditing(undefined); }} /> : <button className="session-item" type="button" onClick={() => onOpen(session.id)}><MessageSquare size={15} /><span>{session.label || "Untitled session"}</span></button>}
				<div className="session-item-actions"><button className="session-more" type="button" aria-label={`Actions for ${session.label || "Untitled session"}`} aria-expanded={menu === session.id} onClick={(event) => { event.stopPropagation(); setMenu((current) => current === session.id ? undefined : session.id); }}><MoreHorizontal size={15} /></button>{menu === session.id ? <div className="session-action-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setMenu(undefined); setEditing(session.id); setLabel(session.label); }}><Pencil size={13} />Rename</button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); void onBranch(session.id); }}><GitBranch size={13} />Branch</button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); void onInspect(session.id).then(setInspect); }}>i <span>Inspect</span></button><button type="button" role="menuitem" onClick={() => { setMenu(undefined); if (window.confirm("Delete this session?")) void onDelete(session.id); }}><Trash2 size={13} />Delete</button></div> : null}</div>
			</div>)}
		</div>
		{inspect ? <div className="session-inspect" role="dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) setInspect(undefined); }}><pre>{JSON.stringify(inspect, null, 2)}</pre><button type="button" onClick={() => setInspect(undefined)}>Close</button></div> : null}
	</>;
}
