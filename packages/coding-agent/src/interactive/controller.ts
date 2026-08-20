import type { ImageContent } from "@di-code/ai";
import type { PluginUiContributions } from "@di-code/plugin-runtime";
import type { AgentSession, AgentSessionEvent } from "../core/session.ts";
import { InteractiveProjection, type InteractiveState } from "../modes/interactive-state.ts";
import type { CodingAgentPluginHost } from "../plugins/runtime-host.ts";

export type InteractiveInput = string | { readonly text: string; readonly images?: readonly ImageContent[] };

export interface InteractiveSessionChoice {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	open(): AgentSession | Promise<AgentSession>;
}

export interface InteractiveControllerState extends InteractiveState {
	readonly model: string;
	readonly provider: string;
	readonly sessionId: string;
	readonly streaming: boolean;
	/** Child runs are host-owned and expose no Agent or Session internals to a frontend. */
	readonly subagents: readonly {
		readonly id: string;
		readonly status: import("@di-code/plugin-runtime").SubagentStatus;
	}[];
}

export type InteractiveViewEvent =
	| { readonly type: "state"; readonly state: InteractiveControllerState }
	| { readonly type: "session_event"; readonly event: AgentSessionEvent }
	| { readonly type: "diagnostic"; readonly message: string }
	| { readonly type: "exit"; readonly reason: "user" | "error" };

export type InteractiveControllerListener = (event: InteractiveViewEvent) => void;

export interface InteractiveControllerOptions {
	readonly session: AgentSession;
	readonly sessions?: readonly InteractiveSessionChoice[];
	readonly runtimePluginHost?: CodingAgentPluginHost;
}

/** Product-layer controller shared by the builtin TUI and future frontends. */
export class InteractiveController {
	private session: AgentSession;
	private readonly sessionChoices: readonly InteractiveSessionChoice[];
	private readonly runtimePluginHost?: CodingAgentPluginHost;
	private readonly projection = new InteractiveProjection();
	private readonly listeners = new Set<InteractiveControllerListener>();
	private unsubscribeSession?: () => void;
	private activeAbort?: AbortController;
	private promptActive = false;
	private switching = false;
	private compactionActive = false;
	private queue: InteractiveInput[] = [];
	private lastRetryInput?: InteractiveInput;
	private disposed = false;

	constructor(options: InteractiveControllerOptions) {
		this.session = options.session;
		this.sessionChoices = [...(options.sessions ?? [])];
		this.runtimePluginHost = options.runtimePluginHost;
		this.projection.replaceTranscript(this.session.transcript);
		this.projection.setUsage(this.session.usage);
		this.subscribeSession();
	}

	get state(): InteractiveControllerState {
		return {
			...this.projection.state,
			model: `${this.session.modelId}${this.session.thinkingLevel ? `(${this.session.thinkingLevel})` : ""}`,
			provider: this.session.providerId,
			sessionId: this.session.sessionId,
			streaming: this.promptActive,
			subagents: this.session.subagents?.list().map((run) => ({ id: run.id, status: run.status })) ?? [],
		};
	}

	/** Restricted panel data and result formatters supplied by active plugin scopes. */
	get ui(): PluginUiContributions {
		return this.runtimePluginHost?.getUiContributions() ?? { panels: [], toolDetailRenderers: [] };
	}

	subscribe(listener: InteractiveControllerListener): { dispose(): void } {
		if (this.disposed) throw new Error("Interactive controller is disposed.");
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async submit(input: InteractiveInput): Promise<void> {
		if (this.disposed) throw new Error("Interactive controller is disposed.");
		const text = typeof input === "string" ? input.trim() : input.text.trim();
		if (!text) return;
		if (this.switching) throw new Error("A session is opening; wait before submitting a prompt.");
		if (this.compactionActive) throw new Error("A compaction is running; wait before submitting a prompt.");
		if (this.promptActive) {
			this.queue.push(typeof input === "string" ? text : { ...input, text });
			this.projection.setQueue(this.queue.map((item) => (typeof item === "string" ? item : item.text)));
			this.emitState();
			return;
		}
		this.promptActive = true;
		this.activeAbort = new AbortController();
		this.emitState();
		try {
			const result =
				typeof input === "string"
					? await this.session.prompt(input, this.activeAbort.signal)
					: await this.session.promptWithImages(input.text, input.images ?? [], this.activeAbort.signal);
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				this.lastRetryInput = typeof input === "string" ? input : { ...input, images: [...(input.images ?? [])] };
				this.projection.setError(result.errorMessage);
			} else this.lastRetryInput = undefined;
		} catch (cause) {
			this.lastRetryInput = typeof input === "string" ? input : { ...input, images: [...(input.images ?? [])] };
			this.reportError(cause);
		} finally {
			this.promptActive = false;
			this.activeAbort = undefined;
			this.emitState();
			const next = this.queue.shift();
			this.projection.setQueue(this.queue.map((item) => (typeof item === "string" ? item : item.text)));
			if (next && !this.disposed) void this.submit(next);
		}
	}

	steer(input: InteractiveInput): void {
		void this.steerAsync(input);
	}

	cancel(): void {
		this.activeAbort?.abort();
	}

	async retry(): Promise<void> {
		if (!this.lastRetryInput) throw new Error("There is no failed or cancelled prompt to retry.");
		if (this.promptActive) throw new Error("Cannot retry while a prompt is running.");
		await this.submit(this.lastRetryInput);
	}

	async runCommand(name: string, args: string): Promise<void> {
		if (!this.runtimePluginHost) throw new Error(`Unknown plugin command: "${name}"`);
		await this.runtimePluginHost.runCommand(name, args, this.session.sessionId);
	}

	selectModel(modelId: string): void {
		this.session.setModel(modelId);
		this.emitState();
	}

	async openSession(sessionId: string): Promise<void> {
		if (this.promptActive || this.switching) throw new Error("Cannot switch sessions while a prompt is running.");
		const choice = this.sessionChoices.find((item) => item.id === sessionId);
		if (!choice) throw new Error(`Unknown session: "${sessionId}"`);
		this.switching = true;
		try {
			await this.session.disposeSubagents();
			const next = await choice.open();
			this.unsubscribeSession?.();
			this.session = next;
			this.projection.replaceTranscript(next.transcript);
			this.projection.setUsage(next.usage);
			this.subscribeSession();
			this.emitState();
		} finally {
			this.switching = false;
		}
	}

	async createSession(): Promise<void> {
		await this.openSession("new-session");
	}

	async requestCompaction(): Promise<void> {
		if (this.promptActive || this.compactionActive) throw new Error("Cannot compact while a prompt is running.");
		this.compactionActive = true;
		this.emitState();
		try {
			await this.session.compact();
		} finally {
			this.compactionActive = false;
			this.emitState();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activeAbort?.abort();
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.listeners.clear();
	}

	async disposeSubagents(): Promise<void> {
		await this.session.disposeSubagents();
	}

	private async steerAsync(input: InteractiveInput): Promise<void> {
		if (!this.promptActive) {
			this.reportError(new Error("Steering is only available while a prompt is running."));
			return;
		}
		try {
			if (typeof input === "string") await this.session.steer(input);
			else await this.session.steerWithImages(input.text, input.images ?? []);
		} catch (cause) {
			this.reportError(cause);
		}
	}

	private subscribeSession(): void {
		this.unsubscribeSession = this.session.subscribeSession((event) => {
			if (event.type === "queue_update") this.projection.setQueue(event.steering);
			else if (event.type === "tree_navigated") this.projection.replaceTranscript(this.session.transcript);
			else if (event.type.startsWith("subagent_")) {
				// Subagent state is read through the restricted controller projection above.
			} else this.projection.apply(event);
			this.emit({ type: "session_event", event });
			this.emitState();
		});
	}

	private emitState(): void {
		this.emit({ type: "state", state: this.state });
	}

	private emit(event: InteractiveViewEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (cause) {
				this.reportError(cause);
			}
		}
	}

	private reportError(cause: unknown): void {
		const message = cause instanceof Error ? cause.message : String(cause);
		this.projection.setError(message);
		for (const listener of this.listeners) listener({ type: "diagnostic", message });
		this.emitState();
	}
}
