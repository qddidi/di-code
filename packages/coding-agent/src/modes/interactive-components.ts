import type { AutocompleteItem, Component, MarkdownTheme } from "@di-code/tui";
import { Markdown, SelectionPanel, Text, truncateToWidth, visibleWidth } from "@di-code/tui";
import { DEFAULT_LOCALE, type Locale, translate } from "../i18n.ts";
import { highlightCode } from "../utils/syntax-highlight.ts";
import { renderDiff } from "./interactive-diff.ts";
import type { InteractiveState } from "./interactive-state.ts";

export interface InteractiveViewState extends InteractiveState {
	readonly model: string;
	readonly theme: "dark" | "light";
	readonly locale?: Locale;
	readonly pasteImageShortcut?: string;
	readonly planMode?: { readonly active: boolean; readonly pending: boolean };
	readonly extensions?: readonly {
		readonly label: string;
		readonly tone: "neutral" | "info" | "success" | "warning" | "error";
	}[];
}

interface Palette {
	readonly accent: string;
	readonly assistant: string;
	readonly dim: string;
	readonly error: string;
	readonly success: string;
	readonly userBackground: string;
	readonly warning: string;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAX_VISIBLE_TOOL_ITEMS = 6;
const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

function paletteFor(theme: InteractiveViewState["theme"]): Palette {
	return theme === "light"
		? {
				accent: "\x1b[38;5;25m",
				assistant: "\x1b[38;5;30m",
				dim: "\x1b[38;5;242m",
				error: "\x1b[38;5;160m",
				success: "\x1b[38;5;28m",
				userBackground: "\x1b[48;2;239;246;255m",
				warning: "\x1b[38;5;130m",
			}
		: {
				accent: "\x1b[38;5;45m",
				assistant: "\x1b[38;5;80m",
				dim: "\x1b[38;5;245m",
				error: "\x1b[38;5;210m",
				success: "\x1b[38;5;114m",
				userBackground: "\x1b[48;2;31;39;50m",
				warning: "\x1b[38;5;222m",
			};
}

function paint(color: string, text: string, bold = false): string {
	return `${color}${bold ? BOLD : ""}${text}${RESET}`;
}

function paintBackground(background: string, text: string): string {
	return `${background}${text}${RESET}`;
}

function markdownThemeFor(colors: Palette): MarkdownTheme {
	return {
		heading: (text) => paint(colors.assistant, text, true),
		link: (text) => paint(colors.accent, text),
		linkUrl: (text) => paint(colors.dim, text),
		code: (text) => paint(colors.warning, text),
		codeBlock: (text) => paint(colors.assistant, text),
		codeBlockBorder: (text) => paint(colors.dim, text),
		quote: (text) => paint(colors.dim, text),
		quoteBorder: (text) => paint(colors.dim, text),
		hr: (text) => paint(colors.dim, text),
		listBullet: (text) => paint(colors.accent, text),
		bold: (text) => paint(colors.assistant, text, true),
		italic: (text) => `\x1b[3m${text}${RESET}`,
		strikethrough: (text) => `\x1b[9m${text}${RESET}`,
		underline: (text) => `\x1b[4m${text}${RESET}`,
		highlightCode: (code, language) =>
			(language ? highlightCode(code, language) : undefined) ??
			code.split("\n").map((line) => paint(colors.assistant, line)),
	};
}

function renderLine(text: string, width: number): string[] {
	return new Text(truncateToWidth(text, width, "")).render(width);
}

function alignEnds(left: string, right: string, width: number): string {
	const gap = 3;
	if (visibleWidth(left) + visibleWidth(right) + gap > width) return truncateToWidth(left, width, "");
	return `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;
}

function activityLabel(state: InteractiveViewState): { readonly text: string; readonly color: string } {
	const colors = paletteFor(state.theme);
	if (state.error) return { text: translate(state.locale ?? DEFAULT_LOCALE, "error"), color: colors.error };
	if (state.compacting) return { text: translate(state.locale ?? DEFAULT_LOCALE, "compacting"), color: colors.warning };
	if (state.retrying) return { text: translate(state.locale ?? DEFAULT_LOCALE, "retrying"), color: colors.warning };
	if (state.busy) return { text: translate(state.locale ?? DEFAULT_LOCALE, "working"), color: colors.accent };
	return { text: translate(state.locale ?? DEFAULT_LOCALE, "ready"), color: colors.success };
}

export class InteractiveHeader implements Component {
	private readonly readState: () => InteractiveViewState;

	constructor(readState: () => InteractiveViewState) {
		this.readState = readState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.readState();
		const colors = paletteFor(state.theme);
		const brand = paint(colors.accent, "DI-CODE / INTERACTIVE", true);
		const model = paint(colors.dim, `MODEL  ${state.model}`);
		const title =
			width >= 56
				? alignEnds(brand, model, width)
				: `${paint(colors.accent, "DI-CODE", true)}  ${paint(colors.dim, state.model)}`;
		return [...renderLine(title, width), ...renderLine(paint(colors.dim, "-".repeat(Math.max(0, width))), width)];
	}
}

export class InteractiveChat implements Component {
	private readonly readState: () => InteractiveViewState;

	constructor(readState: () => InteractiveViewState) {
		this.readState = readState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.readState();
		const lines: string[] = [];
		const colors = paletteFor(state.theme);
		const markdownTheme = markdownThemeFor(colors);
		for (const extension of state.extensions ?? [])
			lines.push(
				...renderLine(
					paint(colors.dim, `[${extension.label}]`, extension.tone === "warning" || extension.tone === "error"),
					width,
				),
			);
		for (const [index, message] of state.messageItems.entries()) {
			if (index > 0) lines.push(" ");
			if (message.role === "file_change") {
				lines.push(
					...renderLine(
						paint(
							colors.dim,
							`${translate(state.locale ?? DEFAULT_LOCALE, message.kind === "edit" ? "edited" : "wrote")} ${message.path}`,
							true,
						),
						width,
					),
				);
				if (message.diff) {
					for (const line of renderDiff(message.diff, colors)) lines.push(...renderLine(line, width));
				} else {
					for (const line of message.removed) lines.push(...renderLine(paint(colors.error, `- ${line}`), width));
					for (const line of message.added) lines.push(...renderLine(paint(colors.success, `+ ${line}`), width));
				}
			} else if (message.role === "user") {
				lines.push(
					...new Text(message.text, 2, 1).render(width).map((line) => paintBackground(colors.userBackground, line)),
				);
			} else {
				lines.push(...new Markdown(message.text, { paddingX: 2, theme: markdownTheme }).render(width));
			}
		}
		const hasProcess = state.processItems.length > 0 || (state.busy && !state.streamingText);
		if (hasProcess && lines.length > 0) lines.push(" ");
		const toolCount = state.processItems.filter((item) => item.type === "tool").length;
		const hiddenToolItems = Math.max(0, toolCount - MAX_VISIBLE_TOOL_ITEMS);
		let skippedToolItems = 0;
		for (const item of state.processItems) {
			if (item.type === "tool" && skippedToolItems < hiddenToolItems) {
				skippedToolItems += 1;
				continue;
			}
			if (item.type === "tool" && skippedToolItems === hiddenToolItems && hiddenToolItems > 0) {
				lines.push(
					...renderLine(
						`    ${paint(colors.dim, translate(state.locale ?? DEFAULT_LOCALE, "earlierToolUpdates", String(hiddenToolItems)))}`,
						width,
					),
				);
				skippedToolItems += 1;
			}
			if (item.type === "thinking") {
				const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
				lines.push(
					...renderLine(
						`    ${paint(colors.accent, `${frame} ${translate(state.locale ?? DEFAULT_LOCALE, "thinking")}`)}`,
						width,
					),
				);
				continue;
			}
			const marker = item.status === "running" ? ">" : item.status === "error" ? "!" : "+";
			const command = truncateToWidth(item.command, Math.max(1, width - 6), "...");
			const color = item.status === "error" ? colors.error : item.status === "done" ? colors.success : colors.warning;
			lines.push(...renderLine(`    ${paint(color, marker)} ${paint(colors.dim, command)}`, width));
		}
		if (state.busy && !state.streamingText && !state.processItems.some((item) => item.type === "thinking")) {
			const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
			lines.push(
				...renderLine(
					`    ${paint(colors.accent, `${frame} ${translate(state.locale ?? DEFAULT_LOCALE, "thinking")}`)}`,
					width,
				),
			);
		}
		if (hasProcess) lines.push(" ");
		if (state.streamingText) {
			if (lines.length > 0 && lines.at(-1) !== " ") lines.push(" ");
			lines.push(...new Markdown(state.streamingText, { paddingX: 2, theme: markdownTheme }).render(width));
		}
		const hasActivity = state.status || state.queue.length > 0 || state.error;
		if (hasActivity) {
			if (lines.length > 0) lines.push(" ");
			lines.push(...renderLine(paint(colors.dim, translate(state.locale ?? DEFAULT_LOCALE, "activity"), true), width));
			if (state.status) lines.push(...renderLine(`    ${paint(colors.dim, state.status)}`, width));
			if (state.queue.length > 0) {
				lines.push(
					...renderLine(
						`    ${paint(colors.dim, translate(state.locale ?? DEFAULT_LOCALE, "queue", String(state.queue.length)))}`,
						width,
					),
				);
				for (const prompt of state.queue) lines.push(...new Text(`      ${prompt}`).render(width));
			}
			if (state.error)
				lines.push(
					...new Text(
						`    ${paint(colors.error, `${translate(state.locale ?? DEFAULT_LOCALE, "errorPrefix")}: ${state.error}`, true)}`,
					).render(width),
				);
		}
		const rendered = lines.flatMap((line) => new Text(line).render(width));
		return rendered.length > 0 ? rendered : [""];
	}
}

export class InteractiveComposer implements Component {
	private readonly readState: () => InteractiveViewState;

	constructor(readState: () => InteractiveViewState) {
		this.readState = readState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.readState();
		const colors = paletteFor(state.theme);
		const locale = state.locale ?? DEFAULT_LOCALE;
		const copy =
			width >= 56
				? `/ ${translate(locale, "commands")}  Tab ${translate(locale, "complete")}`
				: `/ ${translate(locale, "commands")}`;
		return renderLine(paint(colors.dim, copy), width);
	}
}

export class InteractiveFooter implements Component {
	private readonly readState: () => InteractiveViewState;

	constructor(readState: () => InteractiveViewState) {
		this.readState = readState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.readState();
		const colors = paletteFor(state.theme);
		const activity = activityLabel(state);
		const left = paint(activity.color, `* ${activity.text}`, true);
		const context = paint(
			colors.dim,
			`${translate(state.locale ?? DEFAULT_LOCALE, "messages", String(state.messageItems.length))}  ${translate(state.locale ?? DEFAULT_LOCALE, "context")} ${formatTokenCount(state.usage.estimatedContextTokens)}/${formatTokenCount(state.usage.contextWindow)}  ${translate(state.locale ?? DEFAULT_LOCALE, "total")} ${formatTokenCount(state.usage.totalTokens)} ${translate(state.locale ?? DEFAULT_LOCALE, "tokens")}`,
		);
		const plan = state.planMode;
		const planLabel = plan?.pending ? "plan: pending" : plan?.active ? "plan: ON" : "plan: off";
		const model = paint(colors.dim, `${state.model}  ${state.theme}`);
		const right = plan ? `${paint(plan.active ? colors.accent : colors.dim, planLabel)}  ${model}` : model;
		const status = width >= 60 ? alignEnds(`${left}  ${context}`, right, width) : `${left}  ${right}`;
		const pasteImageShortcut = state.pasteImageShortcut ?? (process.platform === "win32" ? "Alt+V" : "Ctrl+V");
		const hints =
			width >= 60
				? `Enter ${translate(state.locale ?? DEFAULT_LOCALE, "send")}   ${pasteImageShortcut} ${translate(state.locale ?? DEFAULT_LOCALE, "pasteImage")}   Alt+P Plan   Shift+Tab ${translate(state.locale ?? DEFAULT_LOCALE, "thinkingShortcut")}   Esc ${translate(state.locale ?? DEFAULT_LOCALE, "cancel")}   Ctrl+O ${translate(state.locale ?? DEFAULT_LOCALE, "model")}`
				: `Enter ${translate(state.locale ?? DEFAULT_LOCALE, "send")}  ${pasteImageShortcut} ${translate(state.locale ?? DEFAULT_LOCALE, "imageShortcut")}`;
		return [...renderLine(status, width), ...renderLine(paint(colors.dim, hints), width)];
	}
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

export interface AutocompleteMenuState {
	readonly items: readonly AutocompleteItem[];
	readonly index: number;
}

export class AutocompleteMenu implements Component {
	private readonly readState: () => AutocompleteMenuState;

	constructor(readState: () => AutocompleteMenuState) {
		this.readState = readState;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.readState();
		const maxVisible = 6;
		const start = Math.min(
			Math.max(0, state.index - Math.floor(maxVisible / 2)),
			Math.max(0, state.items.length - maxVisible),
		);
		const items = state.items.slice(start, start + maxVisible);
		return new SelectionPanel({
			title: "Suggestions",
			rows: items.map((item) => `${item.label}${item.description ? ` - ${item.description}` : ""}`),
			selectedIndex: state.index - start,
			position: state.index + 1,
			total: state.items.length,
		}).render(width);
	}
}
