import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Editor,
	type OverlayHandle,
	SelectList,
	SettingsList,
	type TUI,
} from "@di-code/tui";
import type { AgentSession, AgentSessionEvent } from "../core/session.ts";
import type { ExtensionHost } from "../extensions/runtime.ts";
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

export type { AgentSessionEvent };
export type { InteractiveMessage, InteractiveProcessItem, InteractiveState } from "./interactive-state.ts";
export { InteractiveProjection } from "./interactive-state.ts";

export interface InteractiveModeOptions {
	readonly session: AgentSession;
	readonly tui: TUI;
	readonly onExit?: () => void;
	readonly sessions?: readonly InteractiveSessionChoice[];
	readonly extensionHost?: ExtensionHost;
}

export interface InteractiveSessionChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	open(): AgentSession | Promise<AgentSession>;
}

export class InteractiveMode {
	private readonly projection = new InteractiveProjection();
	private readonly root: InteractiveLayout;
	private readonly editor: Editor;
	private session: AgentSession;
	private readonly tui: TUI;
	private readonly sessionChoices: readonly InteractiveSessionChoice[];
	private readonly extensionHost?: ExtensionHost;
	private unsubscribeSession?: () => void;
	private sessionSwitching = false;
	private promptInFlight = false;
	private compactionInFlight = false;
	private activeAbort?: AbortController;
	private started = false;
	private lastFailedPrompt?: string;
	private queuedPrompts: string[] = [];
	private readonly onExit?: () => void;
	private theme: "dark" | "light" = "dark";
	private overlay?: OverlayHandle;
	private autocompleteOverlay?: OverlayHandle;
	private spinnerTimer?: ReturnType<typeof setInterval>;
	private shutdownEmitted = false;

	constructor(options: InteractiveModeOptions) {
		this.session = options.session;
		this.tui = options.tui;
		this.onExit = options.onExit;
		this.sessionChoices = [...(options.sessions ?? [])];
		this.extensionHost = options.extensionHost;
		const commands = [
			{ name: "help", description: "Show interactive commands" },
			{ name: "clear", description: "Clear visible messages" },
			{ name: "model", description: "Open the model selector" },
			{ name: "session", description: "Open the session selector" },
			{ name: "theme", description: "Open the theme selector" },
			{ name: "settings", description: "Open the settings selector" },
			{ name: "compact", description: "Compact the persisted context now" },
			{ name: "usage", description: "Show token and cost usage" },
			{ name: "retry", description: "Retry the last failed prompt" },
		] as const;
		const allCommands = [...commands, ...(this.extensionHost?.listCommands() ?? [])];
		const autocomplete: AutocompleteProvider = {
			getSuggestions: (context, autocompleteOptions) =>
				new CombinedAutocompleteProvider(allCommands, this.session.allowedRoot).getSuggestions(
					context,
					autocompleteOptions,
				),
			applyCompletion: (context, item, prefix) =>
				new CombinedAutocompleteProvider(allCommands, this.session.allowedRoot).applyCompletion(context, item, prefix),
		};
		this.editor = new Editor({
			maxHeight: 3,
			autocomplete,
		});
		this.editor.onSubmit = (text) => void this.submit(text);
		this.editor.onEscape = () => this.activeAbort?.abort();
		this.editor.onCommand = (data) => this.handleCommand(data);
		this.editor.onInterrupt = () => this.exit();
		this.editor.onAutocompleteChange = () => this.updateAutocompleteOverlay();
		const readViewState = (): InteractiveViewState => ({
			...this.projection.state,
			model: this.session.modelId,
			theme: this.theme,
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
		this.shutdownEmitted = false;
		void this.extensionHost?.emit({ type: "session_start", cwd: this.session.allowedRoot });
		this.projection.replaceTranscript(this.session.transcript);
		this.projection.setUsage(this.session.usage);
		this.subscribeToSession();
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
		this.tui.stop({ finalLines: this.root.renderTranscript(this.tui.columns) });
		if (!this.shutdownEmitted) {
			this.shutdownEmitted = true;
			void this.extensionHost?.emit({ type: "session_shutdown", reason: "user" });
		}
	}

	private exit(): void {
		this.stop();
		this.onExit?.();
	}

	private handleCommand(data: string): boolean {
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
		return false;
	}

	private openThemeSelector(): void {
		const list = new SelectList([
			{ value: "dark", label: "Dark", description: "Dark terminal theme" },
			{ value: "light", label: "Light", description: "Light terminal theme" },
		]);
		list.onSelect = (item) => {
			this.theme = item.value === "light" ? "light" : "dark";
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
		const list = new SelectList([
			{
				value: "__current__",
				label: "Current session",
				description: this.session.sessionFile ?? "In-memory session",
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

	private openSettingsSelector(): void {
		const list = new SettingsList([
			{
				id: "compaction",
				label: "Context compaction",
				currentValue: this.session.compactionEnabled ? "on" : "off",
				values: ["on", "off"],
				description: "Summarize older persisted context before the model limit is reached.",
			},
		]);
		list.onChange = (id, value) => {
			if (id !== "compaction") return;
			try {
				const enabled = this.session.setCompactionEnabled(value === "on");
				list.updateValue(id, enabled ? "on" : "off");
				this.projection.setStatus(
					enabled === (value === "on")
						? `compaction=${enabled ? "on" : "off"}`
						: "compaction unavailable without a persisted session",
				);
			} catch (cause) {
				list.updateValue(id, this.session.compactionEnabled ? "on" : "off");
				this.projection.setError(cause instanceof Error ? cause.message : String(cause));
				this.closeOverlay();
			}
			this.refresh();
		};
		list.onCancel = () => this.closeOverlay();
		this.showOverlay(list);
	}

	private showOverlay(component: SelectList | SettingsList): void {
		this.editor.cancelAutocomplete();
		this.closeAutocompleteOverlay();
		this.closeOverlay();
		this.overlay = this.tui.showOverlay(component, {
			width: "70%",
			maxHeight: "60%",
			anchor: "center",
			margin: 1,
		});
	}

	private closeOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
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
		this.autocompleteOverlay = this.tui.showOverlay(menu, {
			width: "55%",
			maxHeight: 8,
			anchor: "bottom-left",
			margin: 1,
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
			this.projection.apply(event);
			this.refresh();
		});
	}

	private async switchSession(choice: InteractiveSessionChoice): Promise<void> {
		if (this.promptInFlight || this.sessionSwitching) {
			this.projection.setError("Cannot switch sessions while a prompt is running.");
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
			this.queuedPrompts = [];
			this.projection.setQueue([]);
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
		if (prompt.startsWith("/")) {
			this.editor.setValue("");
			this.handleSlashCommand(prompt);
			return;
		}
		if (this.sessionSwitching) {
			this.projection.setError("A session is opening; wait before submitting a prompt.");
			this.refresh();
			return;
		}
		if (this.compactionInFlight) {
			this.projection.setError("A compaction is running; wait before submitting a prompt.");
			this.refresh();
			return;
		}
		if (this.promptInFlight) {
			this.queuedPrompts.push(prompt);
			this.projection.setQueue(this.queuedPrompts);
			this.root.invalidate();
			this.tui.requestRender();
			return;
		}
		this.promptInFlight = true;
		this.activeAbort = new AbortController();
		this.projection.setRetrying(retry);
		this.editor.setValue("");
		try {
			const result = await this.session.prompt(prompt, this.activeAbort.signal);
			if (result.stopReason === "error" || result.stopReason === "aborted") this.lastFailedPrompt = prompt;
			else this.lastFailedPrompt = undefined;
		} catch (cause) {
			this.lastFailedPrompt = prompt;
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			this.promptInFlight = false;
			this.activeAbort = undefined;
			this.projection.setRetrying(false);
			const next = this.queuedPrompts.shift();
			this.projection.setQueue(this.queuedPrompts);
			this.root.invalidate();
			this.tui.requestRender();
			if (next && this.started) void this.submit(next);
		}
	}

	private handleSlashCommand(input: string): void {
		const trimmed = input.slice(1).trim();
		const [rawCommand = "", ...argParts] = trimmed.split(/\s+/);
		const command = rawCommand.toLowerCase();
		const args = argParts.join(" ");
		switch (command) {
			case "help":
				this.projection.setStatus("commands: /clear /model /session /theme /settings /compact /usage /retry");
				break;
			case "clear":
				this.projection.clearVisibleMessages();
				this.projection.setStatus("visible messages cleared");
				break;
			case "model":
				this.openModelSelector();
				return;
			case "session":
				this.openSessionSelector();
				return;
			case "theme":
				this.openThemeSelector();
				return;
			case "settings":
				this.openSettingsSelector();
				return;
			case "compact":
				void this.runManualCompaction();
				return;
			case "usage":
				this.projection.setStatus(this.formatUsage());
				break;
			case "retry":
				if (this.lastFailedPrompt && !this.promptInFlight) void this.submit(this.lastFailedPrompt, true);
				else this.projection.setStatus("nothing to retry");
				break;
			default: {
				if (this.extensionHost?.listCommands().some((entry) => entry.name === command)) {
					void this.extensionHost.runCommand(command, args).catch((cause) => {
						this.projection.setError(cause instanceof Error ? cause.message : String(cause));
						this.refresh();
					});
					break;
				}
				this.projection.setError(`Unknown command: /${command}`);
			}
		}
		this.refresh();
	}

	private formatUsage(): string {
		const usage = this.session.usage;
		return `usage: requests=${usage.requestCount} input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens} cost=$${usage.cost.total.toFixed(4)} context=${usage.estimatedContextTokens}/${usage.contextWindow}`;
	}

	private async runManualCompaction(): Promise<void> {
		if (this.promptInFlight || this.compactionInFlight) {
			this.projection.setError("Cannot compact while a prompt is running.");
			this.refresh();
			return;
		}
		this.compactionInFlight = true;
		this.projection.setStatus("starting manual compaction");
		this.refresh();
		try {
			await this.session.compact();
			this.projection.setStatus("manual compaction complete");
		} catch (cause) {
			this.projection.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			this.compactionInFlight = false;
			this.refresh();
		}
	}
}
