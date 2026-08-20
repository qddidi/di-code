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

/** A small, host-neutral view event surface supplied to a frontend. */
export interface PluginFrontendController {
	readonly state: unknown;
	subscribe(listener: (event: unknown) => void): Disposable;
	submit(input: unknown): Promise<void>;
	steer(input: unknown): void;
	cancel(): void;
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
	start(controller: PluginFrontendController, terminal: PluginTerminalFrontendHost): void | Promise<void>;
	dispose(): void | Promise<void>;
}

export interface PluginInteractiveFrontend {
	readonly id: string;
	readonly displayName: string;
	readonly capabilities: readonly InteractiveFrontendCapability[];
	/** The host validates the returned lifecycle object before starting it. */
	create(): InteractiveFrontend | Record<string, unknown> | Promise<InteractiveFrontend | Record<string, unknown>>;
}

export interface Disposable {
	dispose(): void | Promise<void>;
}
