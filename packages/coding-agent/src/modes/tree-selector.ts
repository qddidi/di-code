import { type Component, type Focusable, Key, matchesKey, SelectionPanel } from "@di-code/tui";
import type { SessionEntry, SessionTreeNode } from "../core/session/types.ts";
import { type Locale, translate } from "../i18n.ts";

const RESET_FOREGROUND = "\x1b[39m";
const CYAN = "\x1b[38;5;45m";
const GREEN = "\x1b[38;5;114m";
const YELLOW = "\x1b[38;5;222m";
const RED = "\x1b[38;5;210m";
const DIM = "\x1b[38;5;245m";
const MAX_VISIBLE_NODES = 12;

interface FlatTreeNode {
	readonly entry: SessionEntry;
	/** Visual indentation only grows where the session graph actually branches. */
	readonly indent: number;
	readonly showConnector: boolean;
	readonly isLast: boolean;
	readonly gutters: readonly TreeGutter[];
	readonly isCurrentPath: boolean;
}

interface TreeGutter {
	readonly level: number;
	readonly continues: boolean;
}

export interface TreeSelectorOptions {
	readonly nodes: readonly SessionTreeNode[];
	readonly leafId?: string;
	readonly locale: Locale;
	onContinue?(entry: SessionEntry): void;
	onEdit?(entry: SessionEntry): void;
	onSummarize?(entry: SessionEntry): void;
	onCancel?(): void;
}

function paint(color: string, text: string): string {
	// Reset only the foreground so a selected row keeps its background across coloured fragments.
	return `${color}${text}${RESET_FOREGROUND}`;
}

function singleLine(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function textContent(entry: SessionEntry): string {
	if (entry.type === "summary") return singleLine(entry.summary);
	if (entry.type === "plugin") return singleLine(`plugin:${entry.pluginId}`);
	return singleLine(
		entry.message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join(" "),
	);
}

function flattenTree(nodes: readonly SessionTreeNode[], leafId: string | undefined): FlatTreeNode[] {
	const parents = new Map<string, string>();
	const raw: Array<Omit<FlatTreeNode, "isCurrentPath">> = [];
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

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		raw.push({
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
			parents.set(child.entry.id, current.node.entry.id);
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

	const currentPath = new Set<string>();
	for (let current = leafId; current; current = parents.get(current)) currentPath.add(current);
	return raw.map((node) => ({ ...node, isCurrentPath: currentPath.has(node.entry.id) }));
}

/** Compact, keyboard-driven session tree browser. It only renders and delegates all state changes to its caller. */
export class TreeSelector implements Component, Focusable {
	focused = false;
	private readonly options: TreeSelectorOptions;
	private readonly nodes: readonly FlatTreeNode[];
	private selectedIndex = 0;

	constructor(options: TreeSelectorOptions) {
		this.options = options;
		this.nodes = flattenTree(options.nodes, options.leafId);
		const selected = this.nodes.findIndex((node) => node.entry.id === options.leafId);
		if (selected >= 0) this.selectedIndex = selected;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.nodes.length === 0)
			return new SelectionPanel({ emptyText: translate(this.options.locale, "treeEmpty"), total: 0 }).render(width);

		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_NODES / 2), this.nodes.length - MAX_VISIBLE_NODES),
		);
		const end = Math.min(this.nodes.length, start + MAX_VISIBLE_NODES);
		const rows: string[] = [];
		for (let index = start; index < end; index += 1) {
			const node = this.nodes[index];
			if (node) rows.push(this.renderNode(node));
		}
		return new SelectionPanel({
			rows,
			selectedIndex: this.selectedIndex - start,
			position: this.selectedIndex + 1,
			total: this.nodes.length,
			hint: this.actionHint(),
		}).render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.select("continue");
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.options.onCancel?.();
			return;
		}
		if (matchesKey(data, "e")) {
			this.select("edit");
			return;
		}
		if (matchesKey(data, "s")) this.select("summarize");
	}

	private renderNode(node: FlatTreeNode): string {
		const prefix = this.renderPrefix(node);
		const currentPath = node.isCurrentPath ? paint(CYAN, "• ") : "  ";
		const content = this.entryDisplay(node.entry);
		return `${prefix}${currentPath}${content}`;
	}

	private renderPrefix(node: FlatTreeNode): string {
		const levels: string[] = [];
		for (let level = 0; level < node.indent; level += 1) {
			const gutter = node.gutters.find((candidate) => candidate.level === level);
			if (gutter) {
				levels.push(paint(DIM, gutter.continues ? "│  " : "   "));
			} else if (node.showConnector && level === node.indent - 1) {
				levels.push(paint(DIM, node.isLast ? "└─ " : "├─ "));
			} else {
				levels.push("   ");
			}
		}
		return levels.join("");
	}

	private entryDisplay(entry: SessionEntry): string {
		const text = textContent(entry);
		if (entry.type === "summary") return `${paint(YELLOW, "summary: ")}${text || paint(DIM, "(empty)")}`;
		if (entry.type === "plugin") return `${paint(DIM, "plugin: ")}${text || paint(DIM, "(empty)")}`;
		if (entry.message.role === "user") return `${paint(CYAN, "user: ")}${text || paint(DIM, "(empty)")}`;
		if (entry.message.role === "assistant") {
			if (text) return `${paint(GREEN, "assistant: ")}${text}`;
			if (entry.message.stopReason === "aborted") return `${paint(GREEN, "assistant: ")}${paint(DIM, "(aborted)")}`;
			if (entry.message.stopReason === "error") return `${paint(GREEN, "assistant: ")}${paint(RED, "(error)")}`;
			return `${paint(GREEN, "assistant: ")}${paint(DIM, "(no text)")}`;
		}
		return `${paint(DIM, `${entry.message.toolName}: `)}${text || paint(DIM, "(no text)")}`;
	}

	private actionHint(): string {
		return `Enter ${translate(this.options.locale, "treeContinue")}  ·  e ${translate(this.options.locale, "treeEdit")}  ·  s ${translate(this.options.locale, "treeSummarize")}  ·  Esc ${translate(this.options.locale, "treeCancel")}`;
	}

	private move(direction: -1 | 1): void {
		if (this.nodes.length === 0) return;
		this.selectedIndex = (this.selectedIndex + direction + this.nodes.length) % this.nodes.length;
	}

	private select(action: "continue" | "edit" | "summarize"): void {
		const entry = this.nodes[this.selectedIndex]?.entry;
		if (!entry) return;
		if (action === "continue") this.options.onContinue?.(entry);
		else if (action === "edit") this.options.onEdit?.(entry);
		else this.options.onSummarize?.(entry);
	}
}
