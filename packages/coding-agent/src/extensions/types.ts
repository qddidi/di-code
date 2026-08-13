import type { AgentEvent } from "@di-code/agent";
import type { Static, ToolResultContent, TSchema } from "@di-code/ai";

export type ExtensionMode = "interactive" | "print" | "json";

export interface ExtensionContext {
	readonly cwd: string;
	readonly mode: ExtensionMode;
	readonly signal?: AbortSignal;
	readonly isProjectTrusted: () => boolean;
	abort: () => void;
}

export interface ExtensionCommandContext extends ExtensionContext {
	readonly args: string;
}

export interface ExtensionCommand {
	readonly name: string;
	readonly description: string;
	readonly handler: (ctx: ExtensionCommandContext) => void | Promise<void>;
}

export interface ExtensionReadOnlyTool<TParameters extends TSchema = TSchema> {
	readonly name: string;
	readonly description: string;
	readonly parameters: TParameters;
	readonly execute: (
		toolCallId: string,
		parameters: Static<TParameters>,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResultContent[]>;
}

export interface SessionStartEvent {
	readonly type: "session_start";
	readonly cwd: string;
}

export interface SessionShutdownEvent {
	readonly type: "session_shutdown";
	readonly reason: "user" | "error";
}

export type ExtensionEvent = AgentEvent | SessionStartEvent | SessionShutdownEvent;

export type ExtensionEventMap = {
	[E in ExtensionEvent["type"]]: Extract<ExtensionEvent, { type: E }>;
};

export type ExtensionEventHandler<E extends keyof ExtensionEventMap> = (
	event: ExtensionEventMap[E],
	ctx: ExtensionContext,
) => void | Promise<void>;

export interface ExtensionAPI {
	registerCommand(command: ExtensionCommand): void;
	registerTool<TParameters extends TSchema>(tool: ExtensionReadOnlyTool<TParameters>): void;
	on<E extends keyof ExtensionEventMap>(event: E, handler: ExtensionEventHandler<E>): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
