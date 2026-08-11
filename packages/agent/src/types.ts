import type { AssistantMessage, Message, Model, Provider, StreamEvent, UserMessage } from "@di-code/ai";

export type AgentMessage = Message;

export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
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
	| { type: "message_start"; message: UserMessage | AssistantMessagePreview }
	| { type: "message_update"; event: MessageUpdateEvent; message: AssistantMessagePreview }
	| { type: "message_end"; message: UserMessage | AssistantMessage }
	| { type: "turn_end"; message: AssistantMessage }
	| { type: "agent_end"; messages: Message[] };
