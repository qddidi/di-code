import { Bot, FileText, GitBranch, MessageSquare, Puzzle, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionTreeEntry, SessionTreeNode } from "../types.ts";
import { useI18n } from "../i18n.tsx";

interface TreeGutter {
	readonly level: number;
	readonly continues: boolean;
}

interface FlatTreeNode {
	readonly entry: SessionTreeEntry;
	readonly indent: number;
	readonly showConnector: boolean;
	readonly isLast: boolean;
	readonly gutters: readonly TreeGutter[];
}

interface EntryMeta {
	readonly label: string;
	readonly tone: "assistant" | "plugin" | "summary" | "tool" | "you";
	readonly Icon: typeof MessageSquare;
}

interface TreeDialogProps {
	readonly open: boolean;
	readonly tree: readonly SessionTreeNode[];
	readonly onClose: () => void;
	readonly onContinue: (entryId: string) => Promise<boolean>;
}

function flatten(nodes: readonly SessionTreeNode[]): readonly FlatTreeNode[] {
	const flat: FlatTreeNode[] = [];
	type PendingNode = {
		readonly node: SessionTreeNode;
		readonly indent: number;
		readonly justBranched: boolean;
		readonly showConnector: boolean;
		readonly isLast: boolean;
		readonly gutters: readonly TreeGutter[];
	};
	const stack: PendingNode[] = [];
	const multipleRoots = nodes.length > 1;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (!node) continue;
		stack.push({
			node,
			indent: multipleRoots ? 1 : 0,
			justBranched: multipleRoots,
			showConnector: multipleRoots,
			isLast: index === nodes.length - 1,
			gutters: [],
		});
	}
	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;
		flat.push({
			entry: current.node.entry,
			indent: current.indent,
			showConnector: current.showConnector,
			isLast: current.isLast,
			gutters: current.gutters,
		});
		const children = current.node.children;
		const multipleChildren = children.length > 1;
		const childIndent = multipleChildren
			? current.indent + 1
			: current.justBranched && current.indent > 0
				? current.indent + 1
				: current.indent;
		const childGutters =
			current.showConnector && current.indent > 0
				? [...current.gutters, { level: current.indent - 1, continues: !current.isLast }]
				: current.gutters;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (!child) continue;
			stack.push({
				node: child,
				indent: childIndent,
				justBranched: multipleChildren,
				showConnector: multipleChildren,
				isLast: index === children.length - 1,
				gutters: childGutters,
			});
		}
	}
	return flat;
}

function singleLine(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function isContinuable(entry: SessionTreeEntry): boolean {
	return !(entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "tool_use");
}

function nextContinuableIndex(nodes: readonly FlatTreeNode[], current: number, direction: -1 | 1): number {
	if (!nodes.length) return -1;
	const start = current < 0 ? (direction === 1 ? -1 : 0) : current;
	for (let offset = 1; offset <= nodes.length; offset += 1) {
		const index = (start + direction * offset + nodes.length) % nodes.length;
		const node = nodes[index];
		if (node && isContinuable(node.entry)) return index;
	}
	return -1;
}

function entryText(entry: SessionTreeEntry): string {
	if (entry.type === "summary") return singleLine(entry.summary ?? "") || "(empty)";
	if (entry.type === "plugin") return `plugin:${entry.pluginId ?? "unknown"}`;
	if (entry.message?.role === "assistant" && entry.message.stopReason === "tool_use") {
		return "(continue from the tool result)";
	}
	const text = entry.message?.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join(" ") ?? "";
	if (text) return singleLine(text);
	if (entry.message?.role === "assistant" && entry.message.stopReason === "error") return "(error)";
	return "(no text)";
}

function entryMeta(entry: SessionTreeEntry): EntryMeta {
	if (entry.type === "summary") return { label: "Summary", tone: "summary", Icon: FileText };
	if (entry.type === "plugin") return { label: "Plugin", tone: "plugin", Icon: Puzzle };
	if (entry.message?.role === "assistant" && entry.message.stopReason === "tool_use") {
		return { label: "Tool call", tone: "tool", Icon: Wrench };
	}
	if (entry.message?.role === "assistant") return { label: "Assistant", tone: "assistant", Icon: Bot };
	if (entry.message?.role === "tool_result") return { label: "Tool", tone: "tool", Icon: Wrench };
	return { label: "You", tone: "you", Icon: MessageSquare };
}

export function TreeDialog({ open, tree, onClose, onContinue }: TreeDialogProps): React.JSX.Element | null {
	const { t } = useI18n();
	const nodes = useMemo(() => flatten(tree), [tree]);
	const [selectedIndex, setSelectedIndex] = useState(-1);
	const [navigating, setNavigating] = useState(false);
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		setSelectedIndex(nextContinuableIndex(nodes, -1, 1));
		requestAnimationFrame(() => closeButton.current?.focus());
	}, [nodes, open]);
	if (!open) return null;
	const selected = selectedIndex >= 0 ? nodes[selectedIndex] : undefined;
	const navigate = async (): Promise<void> => {
		if (!selected || !isContinuable(selected.entry) || navigating) return;
		setNavigating(true);
		try {
			if (await onContinue(selected.entry.id)) onClose();
		} finally {
			setNavigating(false);
		}
	};
	return <div className="overlay tree-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section className="tree-dialog" role="dialog" aria-modal="true" aria-labelledby="tree-dialog-title" onKeyDown={(event) => {
			if (event.key === "Escape") { event.preventDefault(); onClose(); }
			if (event.key === "ArrowDown") { event.preventDefault(); setSelectedIndex((current) => nextContinuableIndex(nodes, current, 1)); }
			if (event.key === "ArrowUp") { event.preventDefault(); setSelectedIndex((current) => nextContinuableIndex(nodes, current, -1)); }
			if (event.key === "Enter") { event.preventDefault(); void navigate(); }
		}}>
			<header className="tree-dialog-header"><div><span className="eyebrow">{t("Session history")}</span><h2 id="tree-dialog-title">{t("Choose where to continue")}</h2></div><button ref={closeButton} className="icon-button" type="button" aria-label={t("Close session tree")} title={t("Close")} onClick={onClose}><X size={17} /></button></header>
			<div className="tree-dialog-list" role="listbox" aria-label="Session tree" aria-activedescendant={selected ? `tree-node-${selected.entry.id}` : undefined}>
				{nodes.length ? nodes.map((node, index) => {
					const meta = entryMeta(node.entry);
					const Icon = meta.Icon;
					const continuable = isContinuable(node.entry);
					return <button id={`tree-node-${node.entry.id}`} className={`tree-dialog-node${index === selectedIndex ? " is-selected" : ""}`} type="button" role="option" aria-selected={index === selectedIndex} aria-disabled={!continuable} disabled={!continuable} title={continuable ? undefined : "Select the resulting tool message to continue."} key={node.entry.id} onClick={() => setSelectedIndex(index)} onDoubleClick={() => void navigate()}>
						<span className="tree-dialog-branch" aria-hidden="true">{Array.from({ length: node.indent }, (_unused, level) => {
							const gutter = node.gutters.find((candidate) => candidate.level === level);
							return <i key={level}>{gutter ? (gutter.continues ? "|" : "") : node.showConnector && level === node.indent - 1 ? (node.isLast ? "`-" : "|-") : ""}</i>;
						})}</span>
						<Icon size={15} className={`tree-dialog-icon tree-dialog-${meta.tone}`} />
						<span className="tree-dialog-copy"><strong>{meta.label}</strong><span>{entryText(node.entry)}</span></span>
					</button>;
				}) : <p className="tree-dialog-empty">{t("This session has no history nodes.")}</p>}
			</div>
			<footer className="tree-dialog-footer"><span>{selected ? `${selectedIndex + 1} / ${nodes.length}` : t("No available nodes")}</span><button type="button" className="tree-continue" disabled={!selected || navigating} onClick={() => void navigate()}><GitBranch size={15} />{navigating ? t("Switching...") : t("Continue from selected")}</button></footer>
		</section>
	</div>;
}
