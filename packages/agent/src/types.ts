import type {
	AssistantMessage,
	Message,
	Model,
	Provider,
	Static,
	StreamEvent,
	ToolDefinition,
	ToolResultContent,
	ToolResultMessage,
	TSchema,
	UserMessage,
} from "@di-code/ai";

export type AgentMessage = Message;

export interface AgentTool<TParameters extends TSchema = TSchema> extends ToolDefinition<TParameters> {
	execute(toolCallId: string, parameters: Static<TParameters>, signal?: AbortSignal): Promise<ToolResultContent[]>;
}

export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
	tools?: readonly AgentTool[];
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
	readonly now?: () => number;
}

export type MessageUpdateEvent = Exclude<StreamEvent, { type: "start" | "done" | "error" }>;

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| {
			type: "message_start";
			message: UserMessage | AssistantMessagePreview | ToolResultMessage;
	  }
	| { type: "message_update"; event: MessageUpdateEvent; message: AssistantMessagePreview }
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
