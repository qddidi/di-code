import { statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { CommandRegistry, InteractiveContextService } from "@di-code/builtins";
import type { UserInteractionInput, UserInteractionResult } from "@di-code/plugin-sdk";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Editor,
	Key,
	matchesKey,
	type OverlayHandle,
	SelectList,
	SettingsList,
	type SlashCommand,
	type TUI,
} from "@di-code/tui";
import {
	cleanupStaleClipboardImages,
	clipboardImageDirectory,
	isClipboardImagePath,
	readClipboardImagePath,
	removeClipboardImage,
} from "../core/clipboard-image.ts";
import { extractImageAttachments } from "../core/image-input.ts";
import type { AgentSession, AgentSessionEvent } from "../core/session.ts";
import { DEFAULT_LOCALE, type Locale, translate } from "../i18n.ts";
import {
	type InteractiveProviderOnboardingOptions,
	showInteractiveProviderOnboarding,
} from "../provider-onboarding.ts";
import type { SessionHostUi } from "../runtime/session-host.ts";
import {
	removeGlobalProviderApiKey,
	saveGlobalLocale,
	saveGlobalModelSelection,
	saveGlobalThinkingLevel,
} from "../startup.ts";
import {
	AutocompleteMenu,
	InteractiveChat,
	InteractiveComposer,
	InteractiveFooter,
	InteractiveHeader,
	type InteractiveViewState,
} from "./interactive-components.ts";
import { InteractiveLayout } from "./interactive-layout.ts";
import { InteractiveProjection } from "./interactive-state.ts";
import { TreeSelector } from "./tree-selector.ts";

export type { AgentSessionEvent };
export type { InteractiveMessage, InteractiveProcessItem, InteractiveState } from "./interactive-state.ts";
export { InteractiveProjection } from "./interactive-state.ts";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const PASTE_IMAGE_KEY = process.platform === "win32" ? Key.alt("v") : Key.ctrl("v");
const PASTE_IMAGE_SHORTCUT = process.platform === "win32" ? "Alt+V" : "Ctrl+V";

function builtinSlashCommands(locale: Locale): readonly SlashCommand[] {
	const t = (key: string) => translate(locale, key);
	return [
		{ name: "help", description: t("showInteractiveCommands") },
		{ name: "clear", description: t("clearVisibleMessages") },
		{ name: "model", description: t("openModelSelector") },
		{ name: "session", description: t("openSessionSelector") },
		{ name: "tree", description: t("openTreeSelector") },
		{ name: "theme", description: t("openThemeSelector") },
		{ name: "settings", description: t("openSettingsSelector") },
		{ name: "login", description: t("chooseProvider") },
		{ name: "logout", description: t("removeProviderKey") },
		{ name: "compact", description: t("compactContext") },
		{ name: "usage", description: t("showUsage") },
		{ name: "retry", description: t("retryPrompt") },
		{ name: "steer", description: t("steerAgent") },
		{ name: "plan", description: "Enter or leave plan mode" },
	];
}

function asImageAttachmentReference(pasted: string, cwd: string): string {
	if (pasted.includes("\n")) return pasted;
	const candidate = pasted.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
	if (!candidate || !IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) return pasted;
	try {
		if (!statSync(resolve(cwd, candidate)).isFile()) return pasted;
	} catch {
		return pasted;
	}
	return `@"${candidate.replaceAll('"', '\\"')}" `;
}

function normalizeDroppedImagePrompt(prompt: string, cwd: string): string {
	const normalized = asImageAttachmentReference(prompt, cwd);
	if (normalized !== prompt) return normalized;
	const prefix = /^((?:(?:[A-Za-z]:[\\/])|(?:\.\.?[\\/])|\/)[\s\S]*?\.(?:gif|jpe?g|png|webp))([\s\S]*)$/i.exec(prompt);
	if (!prefix) return prompt;
	const imageReference = asImageAttachmentReference(prefix[1] ?? "", cwd);
	return imageReference === prefix[1]
		? prompt
		: `${imageReference}${normalizeDroppedImagePrompt(prefix[2] ?? "", cwd)}`;
}

function steeringCommandArgument(prompt: string): string | undefined {
	const match = /^\/steer(?:\s+([\s\S]*))?$/i.exec(prompt);
	return match ? (match[1] ?? "").trim() : undefined;
}

export interface InteractiveModeOptions {
	readonly session: InteractiveSessionHandle;
	readonly tui: TUI;
	readonly onExit?: () => void;
	readonly sessions?: readonly InteractiveSessionChoice[];
	readonly providerOnboarding?: Omit<InteractiveProviderOnboardingOptions, "tui">;
	/** User data directory that owns clipboard image temporaries. */
	readonly agentDir?: string;
	readonly readClipboardImagePath?: (directory?: string) => Promise<string | null>;
	readonly locale?: Locale;
	/** Command contributions are resolved through the composition registry. */
	readonly commandRegistry?: CommandRegistry;
	/** Session controls and preferences are supplied by the active Context. */
	readonly context?: InteractiveContextService;
}

export interface InteractiveSessionChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	open(): InteractiveSessionHandle | Promise<InteractiveSessionHandle>;
}

export type InteractiveSessionHandle = AgentSession | SessionHostUi;
type PlanSessionHandle = {
	readonly planCommand: (args: string) => Promise<string>;
	readonly planMode: () => { readonly active: boolean; readonly pending: boolean } | undefined;
};

interface ContextSessionChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly open: () => unknown | Promise<unknown>;
}

function isContextSessionChoice(value: unknown): value is ContextSessionChoice {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"label" in value &&
		typeof value.label === "string" &&
		"open" in value &&
		typeof value.open === "function"
	);
}

export class InteractiveMode {
	private readonly projection = new InteractiveProjection();
	private readonly root: InteractiveLayout;
	private readonly editor: Editor;
	private session: InteractiveSessionHandle;
	private readonly tui: TUI;
	private readonly sessionChoices: readonly InteractiveSessionChoice[];
	private readonly providerOnboarding?: Omit<InteractiveProviderOnboardingOptions, "tui">;
	private readonly agentDir: string;
	private readonly readClipboardImagePath: (directory?: string) => Promise<string | null>;
	private clipboardDirectory: string;
	private readonly clipboardFiles = new Set<string>();
	private unsubscribeSession?: () => void;
	private sessionSwitching = false;
	private promptInFlight = false;
	private compactionInFlight = false;
	private activeAbort?: AbortController;
	private started = false;
	private lastFailedPrompt?: string;
	private queuedPrompts: string[] = [];
	private steeringPrompts: string[] = [];
	private readonly onExit?: () => void;
	private theme: "dark" | "light" = "dark";
	private overlay?: OverlayHandle;
	private autocompleteOverlay?: OverlayHandle;
	private spinnerTimer?: ReturnType<typeof setInterval>;
	private preserveClipboardFiles = false;
	private locale: Locale;
	private readonly commandRegistry?: CommandRegistry;
	private readonly context?: InteractiveContextService;

	constructor(options: InteractiveModeOptions) {
		this.session = options.session;
		this.projection.configureFilePreview(this.session.allowedRoot, () => this.refresh());
		this.tui = options.tui;
		this.onExit = options.onExit;
		const contextChoices = (options.context?.sessionChoices() ?? []).filter(isContextSessionChoice).map((choice) => ({
			...choice,
			open: async () => {
				const session = await choice.open();
				if (typeof session !== "object" || session === null) throw new Error(`Session choice ${choice.id} is invalid`);
				return session as InteractiveSessionHandle;
			},
		}));
		this.sessionChoices = [...(options.sessions ?? contextChoices)];
		this.providerOnboarding = options.providerOnboarding;
		this.agentDir = resolve(options.agentDir ?? join(homedir(), ".di-code"));
		this.locale = options.locale ?? DEFAULT_LOCALE;
		this.commandRegistry = options.commandRegistry;
		this.context = options.context;
		if (this.context?.theme() === "light") this.theme = "light";
		this.readClipboardImagePath = options.readClipboardImagePath ?? readClipboardImagePath;
		this.clipboardDirectory = clipboardImageDirectory(this.agentDir, this.session.allowedRoot);
		const autocomplete: AutocompleteProvider = {
			getSuggestions: (context, autocompleteOptions) =>
				new CombinedAutocompleteProvider(this.listSlashCommands(), this.session.allowedRoot).getSuggestions(
					context,
					autocompleteOptions,
				),
			applyCompletion: (context, item, prefix) =>
				new CombinedAutocompleteProvider(this.listSlashCommands(), this.session.allowedRoot).applyCompletion(
					context,
					item,
					prefix,
				),
		};
		this.editor = new Editor({
			maxHeight: 3,
			autocomplete,
			submitAutocomplete: (context) => /^\/[^\s/]*$/.test(context.text.slice(0, context.cursor)),
		});
		this.editor.onSubmit = (text) => void this.submit(text);
		this.editor.onEscape = () => {
			if (!this.activeAbort) {
				this.context?.cancel();
				return;
			}
			this.projection.setStatus(translate(this.locale, "cancelled"));
			this.context?.cancel();
			this.activeAbort.abort();
			this.refresh();
		};
		this.editor.onCommand = (data) => this.handleCommand(data);
		this.editor.onInterrupt = () => this.exit();
		this.editor.onChange = () => {
			if (!this.preserveClipboardFiles) {
				void this.cleanupUnreferencedClipboardFiles().catch((cause) => {
					this.projection.setError(cause instanceof Error ? cause.message : String(cause));
					this.refresh();
				});
			}
		};
		this.editor.onAutocompleteChange = () => this.updateAutocompleteOverlay();
		const readViewState = (): InteractiveViewState => ({
			...this.projection.state,
			model: `${this.session.modelId}${this.session.thinkingLevel ? `(${this.session.thinkingLevel})` : ""}`,
			theme: this.theme,
			locale: this.locale,
			pasteImageShortcut: PASTE_IMAGE_SHORTCUT,
			planMode: (this.session as InteractiveSessionHandle & Partial<PlanSessionHandle>).planMode?.(),
		});
		this.root = new InteractiveLayout({
			header: new InteractiveHeader(readViewState),
			chat: new InteractiveChat(readViewState),
			composer: new InteractiveComposer(readViewState),
			editor: this.editor,
			footer: new InteractiveFooter(readViewState),
		});
		this.tui.addChild(this.root);
		this.tui.setFocus(this.editor);
	}

	start(initialPrompt?: string): void {
		if (this.started) throw new Error("Interactive mode is already started");
		this.started = true;
		this.projection.replaceTranscript(this.session.transcript);
		this.projection.setUsage(this.session.usage);
		this.subscribeToSession();
		void cleanupStaleClipboardImages(this.agentDir, this.session.allowedRoot).catch((cause) => {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
			this.refresh();
		});
		try {
			this.tui.start();
		} catch (cause) {
			this.started = false;
			this.unsubscribeSession?.();
			this.unsubscribeSession = undefined;
			throw cause;
		}
		this.startSpinnerTimer();
		if (initialPrompt?.trim()) void this.submit(initialPrompt);
	}

	stop(): void {
		if (!this.started && !this.unsubscribeSession) return;
		this.started = false;
		this.activeAbort?.abort();
		this.activeAbort = undefined;
		this.stopSpinnerTimer();
		this.projection.clearTransientProcess();
		this.closeOverlay();
		this.closeAutocompleteOverlay();
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		void this.cleanupClipboardFiles();
		this.tui.stop({ finalLines: this.root.renderTranscript(this.tui.columns) });
	}

	/** Cancels the active prompt without changing Session history. */
	cancelActivePrompt(): void {
		this.activeAbort?.abort();
	}

	/** Re-submits the last failed prompt when the mode is idle. */
	retryLastPrompt(): void {
		if (this.lastFailedPrompt && !this.promptInFlight) void this.submit(this.lastFailedPrompt, true);
	}

	private exit(): void {
		this.stop();
		this.onExit?.();
	}

	private handleCommand(data: string): boolean {
		this.context?.keybindings();
		if (matchesKey(data, Key.alt("p"))) {
			void this.togglePlanMode();
			return true;
		}
		if (matchesKey(data, Key.alt("s"))) {
			void this.submitSteering(this.editor.getValue());
			return true;
		}
		if (data === "\x1b[Z") {
			try {
				const level = this.session.cycleThinkingLevel();
				this.projection.setStatus(level ? `thinking=${level}` : "Current model does not support thinking levels.");
				if (level) {
					void saveGlobalThinkingLevel(this.agentDir, this.session.providerId, this.session.modelId, level).catch(
						(cause) => {
							this.projection.setError(cause instanceof Error ? cause.message : String(cause));
							this.refresh();
						},
					);
				}
			} catch (cause) {
				this.projection.setError(cause instanceof Error ? cause.message : String(cause));
			}
			this.refresh();
			return true;
		}
		if (data === "\x14") {
			this.openThemeSelector();
			return true;
		}
		if (data === "\x13") {
			this.openSettingsSelector();
			return true;
		}
		if (data === "\x0f") {
			this.openModelSelector();
			return true;
		}
		if (data === "\x0c") {
			this.openSessionSelector();
			return true;
		}
		if (data === "\x12" && this.lastFailedPrompt && !this.promptInFlight) {
			void this.submit(this.lastFailedPrompt, true);
			return true;
		}
		if (matchesKey(data, PASTE_IMAGE_KEY)) {
			void this.attachClipboardImage();
			return true;
		}
		return false;
	}

	private async togglePlanMode(): Promise<void> {
		const planSession = this.session as InteractiveSessionHandle & Partial<PlanSessionHandle>;
		if (!planSession.planCommand || !planSession.planMode) {
			this.projection.setError("Plan mode is unavailable in this session.");
			this.refresh();
			return;
		}
		try {
			const projection = planSession.planMode();
			const message = await planSession.planCommand(projection?.active ? "off" : "");
			this.projection.setStatus(message);
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		}
		this.refresh();
	}

	private async attachClipboardImage(): Promise<void> {
		try {
			const path = await this.readClipboardImagePath(this.clipboardDirectory);
			if (!path) {
				this.projection.setStatus(
					this.locale === "zh-CN" ? "剪贴板中没有受支持的图片。" : "Clipboard has no supported image.",
				);
			} else {
				this.editor.insertTextAtCursor(path);
				if (isClipboardImagePath(path, this.clipboardDirectory)) this.clipboardFiles.add(path);
			}
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		}
		this.refresh();
	}

	private openThemeSelector(): void {
		const t = (key: string) => translate(this.locale, key);
		const list = new SelectList([
			{ value: "dark", label: t("dark"), description: t("darkTheme") },
			{ value: "light", label: t("light"), description: t("lightTheme") },
		]);
		list.onSelect = (item) => {
			this.theme = item.value === "light" ? "light" : "dark";
			this.context?.setTheme(this.theme);
			this.projection.setStatus(`theme=${this.theme}`);
			this.closeOverlay();
			this.refresh();
		};
		list.onCancel = () => this.closeOverlay();
		this.showOverlay(list);
	}

	private openModelSelector(): void {
		const list = new SelectList(
			this.session.availableModels.map((model) => ({
				value: model.id,
				label: model.name,
				description: `${model.provider} / ${model.id} / context ${model.contextWindow}`,
			})),
		);
		list.onSelect = (item) => {
			try {
				this.session.setModel(item.value);
				this.projection.setStatus(`model=${item.value}`);
				void saveGlobalModelSelection(this.agentDir, this.session.providerId, this.session.modelId).catch((cause) => {
					this.projection.setError(cause instanceof Error ? cause.message : String(cause));
					this.refresh();
				});
				this.closeOverlay();
				this.refresh();
			} catch (cause) {
				this.projection.setError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		list.onCancel = () => this.closeOverlay();
		this.showOverlay(list);
	}

	private openSessionSelector(): void {
		const t = (key: string) => translate(this.locale, key);
		const list = new SelectList([
			{
				value: "__current__",
				label: t("currentSession"),
				description: this.session.sessionFile ?? t("inMemorySession"),
			},
			...this.sessionChoices.map((choice) => ({
				value: choice.id,
				label: choice.label,
				...(choice.description ? { description: choice.description } : {}),
			})),
		]);
		list.onSelect = (item) => {
			if (item.value === "__current__") {
				this.projection.setStatus("session=current");
				this.closeOverlay();
				this.refresh();
				return;
			}
			const choice = this.sessionChoices.find((candidate) => candidate.id === item.value);
			if (!choice) return;
			this.closeOverlay();
			void this.switchSession(choice);
		};
		list.onCancel = () => this.closeOverlay();
		this.showOverlay(list);
	}

	private openTreeSelector(): void {
		if (this.promptInFlight || this.compactionInFlight || this.sessionSwitching) {
			this.projection.setError(
				this.locale === "zh-CN"
					? "提示词运行时不能浏览会话树。"
					: "Cannot browse the session tree while a prompt is running.",
			);
			this.refresh();
			return;
		}
		if (this.session.sessionTree.length === 0) {
			this.projection.setStatus(
				this.locale === "zh-CN" ? "当前会话还没有历史节点。" : "The current session has no history nodes.",
			);
			this.refresh();
			return;
		}
		const selector = new TreeSelector({
			nodes: this.session.sessionTree,
			leafId: this.session.sessionLeafId,
			locale: this.locale,
			onContinue: (entry) => {
				this.closeOverlay();
				void this.navigateTreeEntry(entry.id);
			},
			onEdit: (entry) => {
				if (entry.type !== "message" || entry.message.role !== "user") {
					this.projection.setError(
						this.locale === "zh-CN" ? "只能编辑历史用户消息。" : "Only historical user messages can be edited.",
					);
					this.refresh();
					return;
				}
				this.closeOverlay();
				void this.navigateTreeEntry(entry.id);
			},
			onSummarize: (entry) => {
				this.closeOverlay();
				void this.summarizeTreeBranch(entry.id);
			},
			onCancel: () => this.closeOverlay(),
		});
		this.showOverlay(selector, true, "80%");
	}

	private async navigateTreeEntry(entryId: string): Promise<boolean> {
		try {
			const result = await this.session.navigateTree(entryId);
			if (!this.started) return false;
			this.projection.replaceTranscript(this.session.transcript);
			this.editor.setValue(result.editorText ?? "");
			this.projection.setStatus(
				result.imagesOmitted
					? this.locale === "zh-CN"
						? "已恢复文本；请重新附加图片。"
						: "Text restored; reattach images before sending."
					: `tree=${result.selectedEntryId}`,
			);
			return true;
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			this.refresh();
		}
	}

	private async summarizeTreeBranch(entryId: string): Promise<void> {
		if (this.compactionInFlight || this.promptInFlight) return;
		this.compactionInFlight = true;
		this.projection.setStatus(this.locale === "zh-CN" ? "正在为分支生成摘要。" : "Summarizing selected branch.");
		this.refresh();
		try {
			if (!(await this.navigateTreeEntry(entryId))) return;
			await this.session.compact();
			this.editor.setValue("");
			this.projection.replaceTranscript(this.session.transcript);
			this.projection.setStatus(this.locale === "zh-CN" ? "摘要分支已创建。" : "Summary branch created.");
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			this.compactionInFlight = false;
			this.refresh();
		}
	}

	private openSettingsSelector(): void {
		const t = (key: string) => translate(this.locale, key);
		const list = new SettingsList(
			[
				{
					id: "compaction",
					label: t("contextCompaction"),
					currentValue: this.session.compactionEnabled ? t("on") : t("off"),
					values: [t("on"), t("off")],
				},
				{
					id: "locale",
					label: t("language"),
					currentValue: this.locale,
					values: ["en", "zh-CN"],
				},
			],
			{ title: t("settings") },
		);
		list.onChange = (id, value) => {
			if (id === "locale") {
				this.locale = value === "zh-CN" ? "zh-CN" : "en";
				void saveGlobalLocale(this.agentDir, this.locale).catch((cause) => {
					this.projection.setError(cause instanceof Error ? cause.message : String(cause));
					this.refresh();
				});
				this.closeOverlay();
				this.openSettingsSelector();
				return;
			}
			if (id !== "compaction") return;
			try {
				const enabled = this.session.setCompactionEnabled(value === t("on"));
				list.updateValue(id, enabled ? t("on") : t("off"));
				this.projection.setStatus(
					enabled === (value === t("on")) ? `compaction=${enabled ? t("on") : t("off")}` : t("compactionUnavailable"),
				);
			} catch (cause) {
				list.updateValue(id, this.session.compactionEnabled ? t("on") : t("off"));
				this.projection.setError(cause instanceof Error ? cause.message : String(cause));
				this.closeOverlay();
			}
			this.refresh();
		};
		list.onCancel = () => this.closeOverlay();
		this.showOverlay(list);
	}

	private showOverlay(component: Component, preserveLastLine = false, maxHeight: "60%" | "80%" = "60%"): void {
		this.editor.cancelAutocomplete();
		this.closeAutocompleteOverlay();
		this.closeOverlay();
		this.overlay = this.tui.showOverlay(component, {
			width: "70%",
			maxHeight,
			anchor: "center",
			margin: 1,
			preserveLastLine,
		});
	}

	private closeOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
	}

	/** Presents a structured choice for the host UserInteraction bridge. */
	async requestInteraction(input: UserInteractionInput, signal?: AbortSignal): Promise<UserInteractionResult> {
		const options = input.options ?? [];
		if (options.length === 0) return { requestId: input.requestId, toolCallId: input.toolCallId, status: "cancelled" };
		return await new Promise<UserInteractionResult>((resolve) => {
			let settled = false;
			const finish = (result: UserInteractionResult): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				this.closeOverlay();
				resolve(result);
			};
			const abort = (): void =>
				finish({ requestId: input.requestId, toolCallId: input.toolCallId, status: "cancelled" });
			const list = new SelectList(
				options.map((option) => ({ value: option.value, label: option.label, description: input.prompt })),
			);
			list.onSelect = (item) =>
				finish({ requestId: input.requestId, toolCallId: input.toolCallId, status: "answered", value: item.value });
			list.onCancel = abort;
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			this.showOverlay(list, true);
		});
	}

	private updateAutocompleteOverlay(): void {
		this.closeAutocompleteOverlay();
		if (!this.editor.isShowingAutocomplete()) {
			this.refresh();
			return;
		}
		const menu = new AutocompleteMenu(() => ({
			items: this.editor.getAutocompleteItems(),
			index: this.editor.getAutocompleteIndex(),
		}));
		const editorBounds = this.root.getEditorBounds(this.tui.columns);
		this.autocompleteOverlay = this.tui.showOverlay(menu, {
			width: "55%",
			maxHeight: 9,
			anchor: "bottom-left",
			placement: {
				anchorRow: editorBounds.end - 1,
				avoidStartRow: editorBounds.start,
				preferred: "below",
			},
			margin: 1,
			preserveLastLine: true,
			nonCapturing: true,
		});
		this.refresh();
	}

	private closeAutocompleteOverlay(): void {
		this.autocompleteOverlay?.hide();
		this.autocompleteOverlay = undefined;
	}

	private refresh(): void {
		this.root.invalidate();
		this.tui.requestRender();
	}

	private startSpinnerTimer(): void {
		this.stopSpinnerTimer();
		this.spinnerTimer = setInterval(() => {
			if (this.projection.advanceSpinner()) this.refresh();
		}, 120);
		this.spinnerTimer.unref?.();
	}

	private stopSpinnerTimer(): void {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	private subscribeToSession(): void {
		this.unsubscribeSession?.();
		this.unsubscribeSession = this.session.subscribeSession((event) => {
			if (!this.started) return;
			if (event.type === "tree_navigated") {
				this.projection.replaceTranscript(this.session.transcript);
				this.refresh();
				return;
			}
			if (event.type === "queue_update") {
				this.steeringPrompts = [...event.steering];
				this.refreshQueue();
				this.refresh();
				return;
			}
			this.projection.apply(event);
			this.refresh();
		});
	}

	private async switchSession(choice: InteractiveSessionChoice): Promise<void> {
		if (this.sessionSwitching) {
			this.projection.setError(this.locale === "zh-CN" ? "会话正在切换。" : "A session switch is already in progress.");
			this.refresh();
			return;
		}
		this.sessionSwitching = true;
		this.projection.setStatus(`opening session=${choice.id}`);
		this.refresh();
		try {
			const next = await choice.open();
			if (!this.started) return;
			this.unsubscribeSession?.();
			this.session = next;
			this.projection.configureFilePreview(next.allowedRoot, () => this.refresh());
			this.clipboardDirectory = clipboardImageDirectory(this.agentDir, next.allowedRoot);
			void cleanupStaleClipboardImages(this.agentDir, next.allowedRoot);
			this.queuedPrompts = [];
			this.steeringPrompts = [];
			this.refreshQueue();
			this.projection.replaceTranscript(next.transcript);
			this.projection.setUsage(next.usage);
			this.projection.setStatus(`session=${choice.id}`);
			this.subscribeToSession();
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			this.sessionSwitching = false;
		}
		this.refresh();
	}

	private async submit(text: string, retry = false): Promise<void> {
		const prompt = text.trim();
		if (prompt.length === 0 || !this.started) return;
		const steeringArgument = steeringCommandArgument(prompt);
		if (steeringArgument !== undefined) {
			await this.submitSteering(steeringArgument);
			return;
		}
		if (prompt.startsWith("/") && !this.isLoadedSkillCommand(prompt)) {
			this.editor.setValue("");
			this.handleSlashCommand(prompt);
			return;
		}
		if (this.sessionSwitching) {
			this.projection.setError(
				this.locale === "zh-CN"
					? "会话正在打开，请等待后再提交提示词。"
					: "A session is opening; wait before submitting a prompt.",
			);
			this.refresh();
			return;
		}
		if (this.compactionInFlight) {
			this.projection.setError(
				this.locale === "zh-CN"
					? "正在压缩上下文，请等待后再提交提示词。"
					: "A compaction is running; wait before submitting a prompt.",
			);
			this.refresh();
			return;
		}
		if (this.promptInFlight) {
			this.queuedPrompts.push(prompt);
			this.refreshQueue();
			this.root.invalidate();
			this.tui.requestRender();
			return;
		}
		this.promptInFlight = true;
		this.activeAbort = new AbortController();
		this.projection.setRetrying(retry);
		try {
			const input = await extractImageAttachments(
				normalizeDroppedImagePrompt(prompt, this.session.allowedRoot),
				this.session.allowedRoot,
			);
			this.preserveClipboardFiles = true;
			this.editor.setValue("");
			const result =
				retry && "retry" in this.session
					? await this.session.retry(this.activeAbort.signal)
					: await this.session.promptWithImages(input.text, input.images, this.activeAbort.signal);
			if (result.stopReason === "error" || result.stopReason === "aborted") this.lastFailedPrompt = prompt;
			else {
				this.lastFailedPrompt = undefined;
				await this.cleanupClipboardFiles();
			}
		} catch (cause) {
			this.lastFailedPrompt = prompt;
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			this.preserveClipboardFiles = false;
			this.promptInFlight = false;
			this.activeAbort = undefined;
			this.projection.setRetrying(false);
			const next = this.queuedPrompts.shift();
			this.refreshQueue();
			this.root.invalidate();
			this.tui.requestRender();
			if (next && this.started) void this.submit(next);
		}
	}

	private async submitSteering(text: string): Promise<void> {
		const prompt = text.trim();
		if (prompt.length === 0) {
			this.projection.setError(this.locale === "zh-CN" ? "引导内容不能为空。" : "Steering content must not be empty.");
			this.refresh();
			return;
		}
		if (this.sessionSwitching) {
			this.projection.setError(
				this.locale === "zh-CN"
					? "会话正在打开，请等待后再引导 Agent。"
					: "A session is opening; wait before steering the agent.",
			);
			this.refresh();
			return;
		}
		if (this.compactionInFlight) {
			this.projection.setError(
				this.locale === "zh-CN"
					? "正在压缩上下文，请等待后再引导 Agent。"
					: "A compaction is running; wait before steering the agent.",
			);
			this.refresh();
			return;
		}
		if (!this.promptInFlight) {
			this.projection.setError(
				this.locale === "zh-CN"
					? "只能在提示词运行时引导 Agent。"
					: "Steering is only available while a prompt is running.",
			);
			this.refresh();
			return;
		}
		try {
			const input = await extractImageAttachments(
				normalizeDroppedImagePrompt(prompt, this.session.allowedRoot),
				this.session.allowedRoot,
			);
			await this.session.steerWithImages(input.text, input.images);
			this.editor.setValue("");
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		}
		this.refresh();
	}

	private refreshQueue(): void {
		this.projection.setQueue([
			...this.steeringPrompts.map((prompt) => `steer: ${prompt}`),
			...this.queuedPrompts.map((prompt) => `queued: ${prompt}`),
		]);
	}

	private async cleanupUnreferencedClipboardFiles(): Promise<void> {
		const text = this.editor.getValue();
		const files = [...this.clipboardFiles].filter((path) => !text.includes(path));
		await Promise.all(files.map((path) => removeClipboardImage(path, this.clipboardDirectory)));
		for (const path of files) this.clipboardFiles.delete(path);
	}

	private async cleanupClipboardFiles(): Promise<void> {
		const files = [...this.clipboardFiles];
		await Promise.all(files.map((path) => removeClipboardImage(path, this.clipboardDirectory)));
		for (const path of files) this.clipboardFiles.delete(path);
	}

	private handleSlashCommand(input: string): void {
		const trimmed = input.slice(1).trim();
		const [rawCommand = "", ...argParts] = trimmed.split(/\s+/);
		const command = rawCommand.toLowerCase();
		const args = argParts.join(" ");
		if (this.commandRegistry?.list().some((entry) => entry.name === command)) {
			void this.commandRegistry
				.execute(command, {
					host: { runCommand: (name: string, value: string) => this.runRegisteredCommand(name, value) },
					args,
				})
				.catch((cause) => {
					this.projection.setError(cause instanceof Error ? cause.message : String(cause));
					this.refresh();
				});
			this.refresh();
			return;
		}
		this.runRegisteredCommand(command, args);
	}

	private runRegisteredCommand(command: string, _args: string): number {
		switch (command) {
			case "help":
				this.projection.setStatus(
					`commands: ${this.listSlashCommands()
						.map((item) => `/${item.name}`)
						.join(" ")}`,
				);
				break;
			case "clear":
				this.projection.clearVisibleMessages();
				this.projection.setStatus(translate(this.locale, "visibleMessagesCleared"));
				break;
			case "model":
				this.openModelSelector();
				return 0;
			case "session":
				this.openSessionSelector();
				return 0;
			case "tree":
				this.openTreeSelector();
				return 0;
			case "theme":
				this.openThemeSelector();
				return 0;
			case "settings":
				this.openSettingsSelector();
				return 0;
			case "login":
				this.openProviderLogin();
				return 0;
			case "logout":
				void this.logoutProvider();
				return 0;
			case "compact":
				void this.runManualCompaction();
				return 0;
			case "usage":
				this.projection.setStatus(this.formatUsage());
				break;
			case "retry":
				if (this.lastFailedPrompt && !this.promptInFlight) {
					if (this.context) void this.context.retry();
					else void this.submit(this.lastFailedPrompt, true);
				} else this.projection.setStatus(translate(this.locale, "nothingToRetry"));
				break;
			case "plan":
				{
					const planSession = this.session as InteractiveSessionHandle & Partial<PlanSessionHandle>;
					if (!planSession.planCommand || !planSession.planMode) {
						this.projection.setError("Plan mode is unavailable in this session.");
						break;
					}
					void planSession
						.planCommand(_args)
						.then((message) => {
							this.projection.setStatus(`${message}${planSession.planMode?.()?.active ? " [plan]" : ""}`);
							this.refresh();
						})
						.catch((cause) => {
							this.projection.setError(cause instanceof Error ? cause.message : String(cause));
							this.refresh();
						});
				}
				return 0;
			default:
				this.projection.setError(`Unknown command: /${command}`);
		}
		this.refresh();
		return 0;
	}

	private openProviderLogin(): void {
		if (!this.providerOnboarding) {
			this.projection.setError("Provider login is unavailable in this session.");
			this.refresh();
			return;
		}
		if (this.promptInFlight || this.sessionSwitching) {
			this.projection.setError("Cannot change Provider while a prompt is running.");
			this.refresh();
			return;
		}
		this.editor.cancelAutocomplete();
		this.closeAutocompleteOverlay();
		void showInteractiveProviderOnboarding({
			...this.providerOnboarding,
			configuration: { ...this.providerOnboarding.configuration, locale: this.locale },
			tui: this.tui,
		})
			.then((runtime) => {
				if (!this.started) return;
				this.tui.setFocus(this.editor);
				if (!runtime) {
					this.refresh();
					return;
				}
				this.session.setRuntime(runtime.provider, runtime.model);
				this.projection.setStatus(`provider=${runtime.provider.id} model=${runtime.model.id}`);
				this.refresh();
			})
			.catch((cause) => {
				if (this.started) this.tui.setFocus(this.editor);
				this.projection.setError(cause instanceof Error ? cause.message : String(cause));
				this.refresh();
			});
	}

	private async logoutProvider(): Promise<void> {
		if (!this.providerOnboarding) {
			this.projection.setError("Provider logout is unavailable in this session.");
			this.refresh();
			return;
		}
		if (this.promptInFlight || this.sessionSwitching) {
			this.projection.setError("Cannot change Provider while a prompt is running.");
			this.refresh();
			return;
		}
		const providerId = this.session.providerId;
		try {
			const removed = await removeGlobalProviderApiKey(this.providerOnboarding.agentDir, providerId);
			if (!removed) {
				this.projection.setStatus(`no global API key stored for provider=${providerId}`);
				this.refresh();
				return;
			}
			this.projection.setStatus(
				`global API key removed for provider=${providerId}; it remains active until this session ends`,
			);
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		}
		this.refresh();
	}

	private listSlashCommands(): readonly SlashCommand[] {
		const skills = this.session.availableSkills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
		}));
		const registryCommands = this.commandRegistry?.list().map((command) => ({
			name: command.name,
			description: typeof command.description === "function" ? command.description(this.locale) : command.description,
		}));
		return [...(registryCommands ?? builtinSlashCommands(this.locale)), ...skills];
	}

	private isLoadedSkillCommand(input: string): boolean {
		const name = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/.exec(input)?.[1];
		return name !== undefined && this.session.availableSkills.some((skill) => skill.name === name);
	}

	private formatUsage(): string {
		const usage = this.session.usage;
		if (this.locale === "zh-CN") {
			return `用量：请求=${usage.requestCount} 输入=${usage.inputTokens} 输出=${usage.outputTokens} 总计=${usage.totalTokens} 费用=$${usage.cost.total.toFixed(4)} 上下文=${usage.estimatedContextTokens}/${usage.contextWindow}`;
		}
		return `usage: requests=${usage.requestCount} input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens} cost=$${usage.cost.total.toFixed(4)} context=${usage.estimatedContextTokens}/${usage.contextWindow}`;
	}

	private async runManualCompaction(): Promise<void> {
		if (this.promptInFlight || this.compactionInFlight) {
			this.projection.setError(
				this.locale === "zh-CN" ? "提示词运行时不能压缩上下文。" : "Cannot compact while a prompt is running.",
			);
			this.refresh();
			return;
		}
		this.compactionInFlight = true;
		this.projection.setStatus(translate(this.locale, "manualCompactionStarting"));
		this.refresh();
		try {
			await this.session.compact();
			this.projection.setStatus(translate(this.locale, "manualCompactionComplete"));
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			this.compactionInFlight = false;
			this.refresh();
		}
	}
}
