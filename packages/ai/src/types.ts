import type { TSchema } from "typebox";
export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallContent {
	type: "tool_call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

//用户内容
export type UserContent = TextContent | ImageContent;
//agent助手内容
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

//工具结果内容
export type ToolResultContent = TextContent | ImageContent;
//内容块
export type ContentBlock = TextContent | ThinkingContent | ImageContent | ToolCallContent;

//使用量明细
export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}
//费用账单
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCost;
}

//成功停止原因: 正常结束、长度限制、等待执行工具
export type SuccessfulStopReason = "stop" | "length" | "tool_use";
//失败停止原因: 错误、被中断
export type FailedStopReason = "error" | "aborted";
export type StopReason = SuccessfulStopReason | FailedStopReason;

export interface UserMessage {
	role: "user";
	content: UserContent[];
	timestamp: number;
}

export interface ToolResultMessage {
	role: "tool_result";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	isError: boolean;
	timestamp: number;
}

interface AssistantMessageBase {
	role: "assistant";
	content: AssistantContent[];
	provider: string;
	model: string;
	usage: Usage;
	timestamp: number;
}

export interface SuccessfulAssistantMessage extends AssistantMessageBase {
	stopReason: SuccessfulStopReason;
	errorMessage?: never;
}

export interface FailedAssistantMessage extends AssistantMessageBase {
	stopReason: FailedStopReason;
	errorMessage: string;
}

export type AssistantMessage = SuccessfulAssistantMessage | FailedAssistantMessage;

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

//定义模型元数据
export type ModelInput = "text" | "image";

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Model {
	id: string;
	name: string;
	provider: string;
	api: string;
	input: ModelInput[];
	reasoning: boolean;
	contextWindow: number;
	maxOutputTokens: number;
	cost: ModelCost;
}

//定义工具和上下文

export interface ToolDefinition<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDefinition[];
}

//定义流调用边界

export type StreamEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "tool_call_start"; contentIndex: number; id: string; name: string }
	| { type: "tool_call_delta"; contentIndex: number; argumentsDelta: string }
	| { type: "tool_call_end"; contentIndex: number; toolCall: ToolCallContent }
	| { type: "done"; reason: SuccessfulStopReason; message: SuccessfulAssistantMessage }
	| { type: "error"; reason: FailedStopReason; message: FailedAssistantMessage };

export interface StreamOptions {
	signal?: AbortSignal;
	temperature?: number;
	maxTokens?: number;
}
export interface StreamResult extends AsyncIterable<StreamEvent> {
	result(): Promise<AssistantMessage>;
}

export interface Api {
	readonly id: string;
	stream(model: Model, context: Context, options?: StreamOptions): StreamResult;
}

export interface Provider {
	readonly id: string;
	readonly name: string;
	readonly models: readonly Model[];
	stream(model: Model, context: Context, options?: StreamOptions): StreamResult;
}




