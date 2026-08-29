import type {
	AssistantMessage,
	JsonValue,
	Message,
	Model,
	Provider,
	Static,
	StreamEvent,
	ThinkingLevel,
	ToolCallContent,
	ToolDefinition,
	ToolResultContent,
	ToolResultMessage,
	TSchema,
	UserMessage,
} from "@di-code/ai";

export type AgentMessage = Message;

export type AgentToolResult = ToolResultContent[] | ToolExecutionResult<unknown>;

export interface AgentTool<TParameters extends TSchema = TSchema, TResult extends AgentToolResult = ToolResultContent[]>
	extends ToolDefinition<TParameters> {
	execute(toolCallId: string, parameters: Static<TParameters>, signal?: AbortSignal): Promise<TResult>;
}

/** 工具返回给 Agent Loop 的内容和仅供日志/UI 使用的结构化元数据。 */
export interface ToolExecutionResult<TDetails = JsonValue> {
	readonly content: ToolResultContent[];
	readonly details?: TDetails;
}

export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
	tools?: readonly AgentTool<TSchema, AgentToolResult>[];
}

export interface PromptSectionSnapshot {
	readonly agent: {
		readonly turnIndex: number;
		readonly stepIndex: number;
		readonly messageCount: number;
	};
	readonly session?: unknown;
}

export interface PromptSectionContext extends PromptSectionSnapshot {
	readonly signal: AbortSignal;
}

export interface PromptSectionRegistration {
	readonly name: string;
	readonly order: number;
	readonly owner: string;
	readonly generate: (context: PromptSectionContext) => string | undefined | Promise<string | undefined>;
}

export interface PromptSectionRegistry {
	readonly register: (section: PromptSectionRegistration) => () => void;
	readonly snapshot: () => readonly PromptSectionRegistration[];
}

export interface AssistantMessagePreview {
	readonly role: "assistant";
	readonly provider: string;
	readonly model: string;
	readonly text: string;
}

export interface AgentLoopConfig {
	readonly provider: Provider;
	readonly model: Model;
	readonly sessionId?: string;
	readonly now?: () => number;
	readonly thinkingLevel?: ThinkingLevel;
	/** Returns user instructions to inject after the current turn completes. */
	readonly getSteeringMessages?: () => UserMessage[];
	/** Versioned lifecycle hooks executed by the single Agent loop. */
	readonly hooks?: readonly AgentHookRegistration[];
	/** Dynamic prompt sections are evaluated for every Provider request. */
	readonly promptSections?: PromptSectionRegistry;
	readonly getPromptSnapshot?: () => unknown;
}

export const AGENT_HOOK_API_VERSION = 1 as const;
export type AgentHookApiVersion = typeof AGENT_HOOK_API_VERSION;

export type AgentHookPhase =
	| "request_prepare"
	| "pre_step"
	| "request_accept"
	| "tool_execute_before"
	| "step_complete"
	| "turn_complete"
	| "failed"
	| "cancelled";

export interface AgentRequestAssembly {
	readonly systemPrompt?: string;
	readonly messages: readonly Message[];
	readonly tools: readonly AgentTool<TSchema, AgentToolResult>[];
}

export interface AgentHookContext {
	readonly apiVersion: AgentHookApiVersion;
	readonly phase: AgentHookPhase;
	readonly signal: AbortSignal;
	readonly requestId?: string;
	readonly turnIndex: number;
	readonly stepIndex: number;
}

export interface AgentHookEvent {
	readonly phase: AgentHookPhase;
	readonly assembly?: AgentRequestAssembly;
	readonly event?: AgentEvent;
	readonly error?: unknown;
	readonly message?: AssistantMessage;
	readonly toolCall?: ToolCallContent;
	readonly toolResult?: ToolResultMessage;
}

export type AgentPreStepDecision =
	| { readonly type: "continue"; readonly assembly: AgentRequestAssembly }
	| { readonly type: "skip"; readonly reason?: string }
	| { readonly type: "abort"; readonly reason?: string };

export interface AgentHookRegistrationBase {
	readonly apiVersion?: AgentHookApiVersion;
	readonly phase: AgentHookPhase;
	readonly timeoutMs?: number;
	readonly onError?: "ignore" | "fail";
}

export interface AgentHookObserver extends AgentHookRegistrationBase {
	readonly kind: "observer";
	readonly run: (event: AgentHookEvent, context: AgentHookContext) => unknown | Promise<unknown>;
}

export interface AgentHookModifier extends AgentHookRegistrationBase {
	readonly kind: "modifier";
	readonly phase: "pre_step";
	readonly run: (
		event: AgentHookEvent,
		context: AgentHookContext,
	) => AgentPreStepDecision | undefined | Promise<AgentPreStepDecision | undefined>;
}

export type AgentHookRegistration = AgentHookObserver | AgentHookModifier;

export type MessageUpdateEvent = Exclude<StreamEvent, { type: "start" | "done" | "error" }>;

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| {
			type: "message_start";
			message: UserMessage | AssistantMessagePreview | ToolResultMessage;
	  }
	| { type: "message_update"; event: MessageUpdateEvent }
	| { type: "message_end"; message: UserMessage | AssistantMessage | ToolResultMessage }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			arguments: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: ToolResultMessage;
	  }
	| { type: "agent_end"; messages: Message[] };
