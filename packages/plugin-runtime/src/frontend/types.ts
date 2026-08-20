/** Capabilities that a complete interactive frontend may advertise. */
export type InteractiveFrontendCapability =
	| "streaming"
	| "tool-status"
	| "cancel"
	| "retry"
	| "commands"
	| "model-selection"
	| "session-selection"
	| "compaction"
	| (string & {});

/** Data a normal plugin may offer for an active frontend to render in its own layout. */
export interface PluginInteractivePanel {
	readonly id: string;
	readonly title: string;
	readonly data: unknown;
}

/** A pure, optional formatter for one tool's completed result. */
export interface PluginToolDetailRenderer {
	readonly toolName: string;
	render(result: unknown): string | undefined;
}

export interface PluginUiContributions {
	readonly panels: readonly PluginInteractivePanel[];
	readonly toolDetailRenderers: readonly PluginToolDetailRenderer[];
}

/** A small, host-neutral view event surface supplied to a frontend. */
export interface PluginFrontendController {
	readonly state: unknown;
	readonly ui: PluginUiContributions;
	subscribe(listener: (event: unknown) => void): Disposable;
	submit(input: unknown): Promise<void>;
	steer(input: unknown): void;
	cancel(): void;
	retry(): Promise<void>;
	runCommand(name: string, args: string): Promise<void>;
	selectModel(modelId: string): void;
	openSession(sessionId: string): Promise<void>;
	createSession(): Promise<void>;
	requestCompaction(): Promise<void>;
}

/** Terminal ownership is passed by the host; frontends must not access process stdio directly. */
export interface PluginTerminalFrontendHost {
	readonly columns: number;
	readonly rows: number;
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	setTitle(title: string): void;
}

export interface InteractiveFrontend {
	/** Resolves only after this frontend has released terminal ownership. */
	start(controller: PluginFrontendController, terminal: PluginTerminalFrontendHost): Promise<void>;
	dispose(): Promise<void>;
}

export interface PluginInteractiveFrontend {
	readonly id: string;
	readonly displayName: string;
	readonly capabilities: readonly InteractiveFrontendCapability[];
	/** The host validates the returned lifecycle object before starting it. */
	create(): InteractiveFrontend | Promise<InteractiveFrontend>;
}

export interface Disposable {
	dispose(): void | Promise<void>;
}
