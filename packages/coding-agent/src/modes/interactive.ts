import type { Message } from "@di-code/ai";
import { type Component, Container, Editor, Text, type TUI } from "@di-code/tui";
import type { AgentSession, AgentSessionEvent } from "../core/session.ts";

export type { AgentSessionEvent };

export interface InteractiveState {
	readonly messages: readonly string[];
	readonly streamingText: string;
	readonly toolStatus: readonly string[];
	readonly busy: boolean;
	readonly error?: string;
	readonly queue: readonly string[];
	readonly status?: string;
	readonly selector?: {
		readonly kind: "model" | "session" | "theme" | "settings";
		readonly options: readonly string[];
		readonly index: number;
	};
	readonly compacting: boolean;
	readonly retrying: boolean;
}

function textOf(message: Message): string {
	type TextBlock = Extract<Message["content"][number], { type: "text" }>;
	return message.content
		.filter((content): content is TextBlock => content.type === "text")
		.map((content) => content.text)
		.join("");
}

export class InteractiveProjection {
	private readonly messages: string[] = [];
	private readonly toolStatus = new Map<string, string>();
	private streamingText = "";
	private busy = false;
	private error: string | undefined;
	private queue: string[] = [];
	private status: string | undefined;
	private selector: InteractiveState["selector"];
	private compacting = false;
	private retrying = false;

	get state(): InteractiveState {
		return {
			messages: [...this.messages],
			streamingText: this.streamingText,
			toolStatus: [...this.toolStatus.values()],
			busy: this.busy,
			error: this.error,
			queue: [...this.queue],
			status: this.status,
			selector: this.selector ? { ...this.selector, options: [...this.selector.options] } : undefined,
			compacting: this.compacting,
			retrying: this.retrying,
		};
	}

	setError(message: string): void {
		this.error = message;
	}
	setQueue(queue: readonly string[]): void {
		this.queue = [...queue];
	}
	setStatus(status: string | undefined): void {
		this.status = status;
	}
	setSelector(selector: InteractiveState["selector"]): void {
		this.selector = selector;
	}
	setCompacting(value: boolean): void {
		this.compacting = value;
	}
	setRetrying(value: boolean): void {
		this.retrying = value;
	}

	apply(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.error = undefined;
				this.retrying = false;
				return;
			case "compaction_start":
				this.compacting = true;
				return;
			case "compaction_end":
				this.compacting = false;
				if (!event.success) this.error = event.errorMessage;
				return;
			case "message_start":
				if (event.message.role === "assistant") this.streamingText = "";
				return;
			case "message_update":
				if (event.message.role === "assistant") this.streamingText = event.message.text;
				return;
			case "tool_execution_start":
				this.toolStatus.set(event.toolCallId, `${event.toolName}: running`);
				return;
			case "tool_execution_end":
				this.toolStatus.set(event.toolCallId, `${event.toolName}: ${event.result.isError ? "error" : "done"}`);
				return;
			case "message_end":
				if (event.message.role === "user") {
					const text = textOf(event.message);
					if (text.length > 0) this.messages.push(text);
					return;
				}
				if (event.message.role !== "assistant") return;
				{
					const text = textOf(event.message);
					if (text.length > 0 && event.message.stopReason !== "tool_use") this.messages.push(text);
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
						this.error = event.message.errorMessage;
					}
					this.streamingText = "";
				}
				return;
			case "agent_end":
				this.busy = false;
				this.retrying = false;
				return;
			case "turn_start":
			case "turn_end":
				return;
		}
	}
}

class InteractiveChat implements Component {
	private readonly projection: InteractiveProjection;

	constructor(projection: InteractiveProjection) {
		this.projection = projection;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.projection.state;
		const lines = [
			...state.messages,
			...(state.status ? [`status: ${state.status}`] : []),
			...(state.compacting ? ["status: compacting context"] : []),
			...(state.retrying ? ["status: retrying"] : []),
			...(state.streamingText ? [`assistant: ${state.streamingText}`] : []),
			...state.toolStatus.map((status) => `tool: ${status}`),
			...state.queue.map((prompt) => `queued: ${prompt}`),
			...(state.selector
				? [
						`${state.selector.kind}: ${state.selector.options.map((option, index) => (index === state.selector?.index ? `[${option}]` : option)).join(" | ")}`,
					]
				: []),
			...(state.error ? [`error: ${state.error}`] : []),
		];
		return lines.flatMap((line) => new Text(line).render(width));
	}
}

export interface InteractiveModeOptions {
	readonly session: AgentSession;
	readonly tui: TUI;
	readonly onExit?: () => void;
}

export class InteractiveMode {
	private readonly projection = new InteractiveProjection();
	private readonly root = new Container();
	private readonly editor = new Editor({ maxHeight: 3 });
	private readonly session: AgentSession;
	private readonly tui: TUI;
	private unsubscribe?: () => void;
	private unsubscribeSession?: () => void;
	private promptInFlight = false;
	private activeAbort?: AbortController;
	private started = false;
	private lastFailedPrompt?: string;
	private queuedPrompts: string[] = [];
	private readonly onExit?: () => void;

	constructor(options: InteractiveModeOptions) {
		this.session = options.session;
		this.tui = options.tui;
		this.onExit = options.onExit;
		this.editor.onSubmit = (text) => void this.submit(text);
		this.editor.onEscape = () => this.cancelOrCloseSelector();
		this.editor.onCommand = (data) => this.handleCommand(data);
		this.editor.onInterrupt = () => this.exit();
		this.root.addChild(new InteractiveChat(this.projection));
		this.root.addChild(this.editor);
		this.tui.addChild(this.root);
		this.tui.setFocus(this.editor);
	}

	start(initialPrompt?: string): void {
		if (this.started) throw new Error("Interactive mode is already started");
		this.started = true;
		const handleEvent = (event: AgentSessionEvent): void => {
			if (!this.started) return;
			this.projection.apply(event);
			this.root.invalidate();
			this.tui.requestRender();
		};
		this.unsubscribeSession = this.session.subscribeSession(handleEvent);
		try {
			this.tui.start();
		} catch (cause) {
			this.started = false;
			this.unsubscribe?.();
			this.unsubscribeSession?.();
			this.unsubscribe = undefined;
			this.unsubscribeSession = undefined;
			throw cause;
		}
		if (initialPrompt?.trim()) void this.submit(initialPrompt);
	}

	stop(): void {
		if (!this.started && !this.unsubscribe && !this.unsubscribeSession) return;
		this.started = false;
		this.activeAbort?.abort();
		this.activeAbort = undefined;
		this.unsubscribe?.();
		this.unsubscribeSession?.();
		this.unsubscribe = undefined;
		this.unsubscribeSession = undefined;
		this.tui.stop();
	}

	private cancelOrCloseSelector(): void {
		if (this.projection.state.selector) {
			this.projection.setSelector(undefined);
			this.root.invalidate();
			this.tui.requestRender();
			return;
		}
		this.activeAbort?.abort();
	}

	private exit(): void {
		this.stop();
		this.onExit?.();
	}

	private handleCommand(data: string): boolean {
		const selector = this.projection.state.selector;
		if (selector) {
			if (data === "\x1b[A" || data === "\x1b[B") {
				const direction = data === "\x1b[A" ? -1 : 1;
				const index = (selector.index + direction + selector.options.length) % selector.options.length;
				this.projection.setSelector({ ...selector, index });
				this.root.invalidate();
				this.tui.requestRender();
				return true;
			}
			if (data === "\r" || data === "\n") {
				this.projection.setStatus(`${selector.kind}=${selector.options[selector.index]}`);
				this.projection.setSelector(undefined);
				this.root.invalidate();
				this.tui.requestRender();
				return true;
			}
			if (data === "\x1b") {
				this.projection.setSelector(undefined);
				this.root.invalidate();
				this.tui.requestRender();
				return true;
			}
			return true;
		}
		const selectors: Record<string, InteractiveState["selector"]> = {
			"\x0f": { kind: "model", options: ["faux-model"], index: 0 },
			"\x0c": { kind: "session", options: ["current-session", "new-session"], index: 0 },
			"\x14": { kind: "theme", options: ["dark", "light"], index: 0 },
			"\x13": { kind: "settings", options: ["compaction:on", "compaction:off"], index: 0 },
		};
		const nextSelector = selectors[data];
		if (nextSelector) {
			this.projection.setSelector(nextSelector);
			this.root.invalidate();
			this.tui.requestRender();
			return true;
		}
		if (data === "\x12" && this.lastFailedPrompt && !this.promptInFlight) {
			void this.submit(this.lastFailedPrompt, true);
			return true;
		}
		return false;
	}

	private async submit(text: string, retry = false): Promise<void> {
		const prompt = text.trim();
		if (prompt.length === 0 || !this.started) return;
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
}
