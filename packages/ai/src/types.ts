import type { TSchema } from "typebox";

/** 模型输入或输出中的纯文本内容块。 */
export interface TextContent {
	/** 用于可辨识联合类型判断的内容种类。 */
	type: "text";
	/** 完整的文本内容。 */
	text: string;
}

/** 助手生成的思考内容块。 */
export interface ThinkingContent {
	/** 用于可辨识联合类型判断的内容种类。 */
	type: "thinking";
	/** 完整的思考文本。 */
	thinking: string;
}

/** 使用 Base64 数据和 MIME 类型表示的图片内容块。 */
export interface ImageContent {
	/** 用于可辨识联合类型判断的内容种类。 */
	type: "image";
	/** 不包含 data URL 前缀的 Base64 图片数据。 */
	data: string;
	/** 图片的媒体类型，例如 image/png。 */
	mimeType: string;
}

/** 助手请求调用某个工具时生成的内容块。 */
export interface ToolCallContent {
	/** 用于可辨识联合类型判断的内容种类。 */
	type: "tool_call";
	/** 本次工具调用的唯一标识，用于关联后续工具结果。 */
	id: string;
	/** 要调用的工具名称。 */
	name: string;
	/** 已解析且通过运行时校验的工具参数。 */
	arguments: Record<string, unknown>;
}

/** 可安全序列化到请求或会话文件中的 JSON 值。 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** 由产生消息的 Provider 保存、仅供同一 API adapter 回放的不透明数据。 */
export interface ProviderReplay {
	/** 能够解释 data 的 API adapter 标识。 */
	readonly api: string;
	/** 不允许包含函数、类实例或非有限数值的 JSON 数据。 */
	readonly data: JsonValue;
}

/** 用户消息允许包含的内容块。 */
export type UserContent = TextContent | ImageContent;

/** 助手消息允许包含的内容块。 */
export type AssistantContent = TextContent | ThinkingContent | ImageContent | ToolCallContent;

/** 工具结果消息允许返回的内容块。 */
export type ToolResultContent = TextContent | ImageContent;

/** AI 层所有消息中可能出现的内容块。 */
export type ContentBlock = TextContent | ThinkingContent | ImageContent | ToolCallContent;

/** 一次模型请求按来源拆分的费用明细。 */
export interface UsageCost {
	/** 输入 token 对应的费用。 */
	input: number;
	/** 输出 token 对应的费用。 */
	output: number;
	/** 从缓存读取的 token 对应的费用。 */
	cacheRead: number;
	/** 写入缓存的 token 对应的费用。 */
	cacheWrite: number;
	/** 本次请求的总费用。 */
	total: number;
}

/** 一次模型请求的 token 使用量和费用汇总。 */
export interface Usage {
	/** 未计入缓存读写部分的输入 token 数。 */
	input: number;
	/** 模型生成的输出 token 数。 */
	output: number;
	/** 从 Provider 缓存读取的 token 数。 */
	cacheRead: number;
	/** 写入 Provider 缓存的 token 数。 */
	cacheWrite: number;
	/** 本次请求统计到的总 token 数。 */
	totalTokens: number;
	/** 按 token 来源计算出的费用明细。 */
	cost: UsageCost;
}

/** 成功完成生成时的停止原因：正常结束、达到长度限制或请求调用工具。 */
export type SuccessfulStopReason = "stop" | "length" | "tool_use";

/** 未成功完成生成时的停止原因：执行错误或请求被中止。 */
export type FailedStopReason = "error" | "aborted";

/** 助手消息所有可能的停止原因。 */
export type StopReason = SuccessfulStopReason | FailedStopReason;

/** 用户发送给模型的一条消息。 */
export interface UserMessage {
	/** 固定为 user，用于区分消息角色。 */
	role: "user";
	/** 用户提供的文本或图片内容。 */
	content: UserContent[];
	/** 消息创建时间，使用 Unix 毫秒时间戳。 */
	timestamp: number;
}

/** 工具执行完成后返回给模型的一条结果消息。 */
export interface ToolResultMessage<TDetails = JsonValue> {
	/** 固定为 tool_result，用于区分消息角色。 */
	role: "tool_result";
	/** 对应 ToolCallContent.id 的工具调用标识。 */
	toolCallId: string;
	/** 被执行的工具名称。 */
	toolName: string;
	/** 工具返回的文本或图片内容。 */
	content: ToolResultContent[];
	/** 工具实现提供给日志和 UI 的结构化元数据，不发送给模型。 */
	details?: TDetails;
	/** 表示该结果是否来自工具执行失败。 */
	isError: boolean;
	/** 结果消息创建时间，使用 Unix 毫秒时间戳。 */
	timestamp: number;
}

/** 成功与失败助手消息共享的基础字段。 */
interface AssistantMessageBase {
	/** 固定为 assistant，用于区分消息角色。 */
	role: "assistant";
	/** 助手生成的文本、思考或工具调用内容。 */
	content: AssistantContent[];
	/** 实际完成本次生成的 Provider 标识。 */
	provider: string;
	/** 实际完成本次生成的模型标识。 */
	model: string;
	/** 同 Provider、同模型后续请求所需的可选不透明回放载荷。 */
	providerReplay?: ProviderReplay;
	/** 本次模型请求的 token 和费用统计。 */
	usage: Usage;
	/** 助手消息创建时间，使用 Unix 毫秒时间戳。 */
	timestamp: number;
}

/** 正常结束、达到长度限制或等待工具执行的助手消息。 */
export interface SuccessfulAssistantMessage extends AssistantMessageBase {
	/** 描述本次生成成功停止的原因。 */
	stopReason: SuccessfulStopReason;
	/** 成功消息不允许携带错误文本。 */
	errorMessage?: never;
}

/** 因错误或中止而结束的助手消息。 */
export interface FailedAssistantMessage extends AssistantMessageBase {
	/** 描述本次生成失败停止的原因。 */
	stopReason: FailedStopReason;
	/** 面向调用者的失败原因说明。 */
	errorMessage: string;
}

/** 根据 stopReason 区分成功和失败形态的助手消息。 */
export type AssistantMessage = SuccessfulAssistantMessage | FailedAssistantMessage;

/** 对话历史中允许保存的全部消息角色。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 模型能够接收的输入模态。 */
export type ModelInput = "text" | "image";

/** 模型针对不同 token 来源配置的计价信息。 */
export interface ModelCost {
	/** 输入 token 的计价。 */
	input: number;
	/** 输出 token 的计价。 */
	output: number;
	/** 缓存读取 token 的计价。 */
	cacheRead: number;
	/** 缓存写入 token 的计价。 */
	cacheWrite: number;
}

/** Provider 无关的模型元数据和能力描述。 */
export interface Model {
	/** Provider 内唯一的模型标识。 */
	id: string;
	/** 面向用户展示的模型名称。 */
	name: string;
	/** 提供该模型的 Provider 标识。 */
	provider: string;
	/** 调用该模型时使用的底层 API 标识。 */
	api: string;
	/** 真实模型的默认请求 endpoint；Faux 和临时测试模型可以省略。 */
	baseUrl?: string;
	/** 为支持该能力的 Provider 请求更长的提示词缓存保留时间。 */
	cacheRetention?: "long";
	/** 使用 Codex 的 session-id 请求头维持缓存路由亲和性。 */
	sessionAffinity?: "codex";
	/** 模型支持的输入模态列表。 */
	input: ModelInput[];
	/** 模型是否支持生成独立的思考内容。 */
	reasoning: boolean;
	/** 该模型在当前 API 适配器中支持的思考强度；未声明表示不可调节。 */
	reasoningEfforts?: readonly ThinkingLevel[];
	/** 新会话采用的思考强度；必须属于 reasoningEfforts。 */
	defaultReasoningEffort?: ThinkingLevel;
	/** 当前模型在 OpenAI Chat Completions 协议上的兼容能力。 */
	chatCompletionsCompat?: OpenAIChatCompletionsCompat;
	/** 单次请求可容纳的最大上下文 token 数。 */
	contextWindow: number;
	/** 单次请求允许生成的最大输出 token 数。 */
	maxOutputTokens: number;
	/** 模型按 token 来源划分的计价信息。 */
	cost: ModelCost;
}

/** Provider 无关的离散思考强度名称。 */
export type ThinkingLevel = "low" | "medium" | "high" | "max";

/** AI 层支持的底层协议标识；厂商 ID 不属于这个联合类型。 */
export type ModelApi =
	| "faux"
	| "openai-responses"
	| "deepseek-responses"
	| "openai-chat-completions"
	| "anthropic-messages";

/** OpenAI Chat Completions 兼容端点的有限、可验证能力开关。 */
export interface OpenAIChatCompletionsCompat {
	/** 流式响应是否接受 stream_options.include_usage。默认 true。 */
	readonly supportsUsageInStreaming?: boolean;
	/** max token 字段名；未声明时使用 max_completion_tokens。 */
	readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** 思考参数格式；厂商扩展只在对应模型声明时发送。 */
	readonly thinkingFormat?: "zai" | "deepseek" | "kimi";
	/** 是否接受 reasoning_effort 字段。 */
	readonly supportsReasoningEffort?: boolean;
	/** 是否在有工具时启用智谱增量工具流。 */
	readonly zaiToolStream?: boolean;
}

/** 提供给模型的工具名称、说明和 TypeBox 参数模式。 */
export interface ToolDefinition<TParameters extends TSchema = TSchema> {
	/** 模型在 ToolCallContent 中引用的工具名称。 */
	name: string;
	/** 帮助模型判断何时以及如何使用工具的说明。 */
	description: string;
	/** 用于描述并在运行时校验工具参数的 TypeBox Schema。 */
	parameters: TParameters;
}

/** 一次模型调用所需的提示词、消息历史和可用工具。 */
export interface Context {
	/** Provider 应作为系统级指令发送的提示词。 */
	systemPrompt?: string;
	/** 按时间顺序发送给模型的对话消息。 */
	messages: Message[];
	/** 本次调用允许模型请求执行的工具。 */
	tools?: ToolDefinition[];
}

/** Provider 流式生成过程中按协议顺序发出的事件。 */
export type StreamEvent =
	/** 流已经建立，尚未开始生成内容块。 */
	| { type: "start" }
	/** 开始生成一个文本块；contentIndex 是其在最终 content 数组中的下标。 */
	| { type: "text_start"; contentIndex: number }
	/** 向当前文本块追加一段文本。 */
	| { type: "text_delta"; contentIndex: number; delta: string }
	/** 当前文本块结束，并给出拼接后的完整文本。 */
	| { type: "text_end"; contentIndex: number; content: string }
	/** 开始生成一个思考块；contentIndex 是其在最终 content 数组中的下标。 */
	| { type: "thinking_start"; contentIndex: number }
	/** 向当前思考块追加一段文本。 */
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	/** 当前思考块结束，并给出拼接后的完整思考文本。 */
	| { type: "thinking_end"; contentIndex: number; content: string }
	/** A complete generated image. Providers buffer image bytes before emitting this atomic event. */
	| { type: "image"; contentIndex: number; image: ImageContent }
	/** 开始生成工具调用，并给出调用标识和工具名称。 */
	| { type: "tool_call_start"; contentIndex: number; id: string; name: string }
	/** 向当前工具调用追加一段尚未解析的 JSON 参数文本。 */
	| { type: "tool_call_delta"; contentIndex: number; argumentsDelta: string }
	/** 当前工具调用结束，并给出已解析、已校验的完整调用内容。 */
	| { type: "tool_call_end"; contentIndex: number; toolCall: ToolCallContent }
	/** 流成功结束，并携带权威的最终助手消息。 */
	| { type: "done"; reason: SuccessfulStopReason; message: SuccessfulAssistantMessage }
	/** 流因错误或中止结束，并携带结构化的失败助手消息。 */
	| { type: "error"; reason: FailedStopReason; message: FailedAssistantMessage };

/** 控制单次流式模型调用的可选参数。 */
export interface StreamOptions {
	/** 用于中止底层请求和后续流式生成。 */
	signal?: AbortSignal;
	/** 同一会话内保持稳定的标识；支持的 Provider 可用它提高提示词缓存命中率。 */
	sessionId?: string;
	/** 控制采样随机性的温度参数，支持情况和有效范围由具体 Provider 决定。 */
	temperature?: number;
	/** 本次调用允许生成的最大 token 数。 */
	maxTokens?: number;
	/** 本次请求使用的思考强度；只由声明支持它的 Provider 解释。 */
	reasoningEffort?: ThinkingLevel;
}

/** 既可逐个消费事件，也可等待最终助手消息的流式结果。 */
export interface StreamResult extends AsyncIterable<StreamEvent> {
	/** 返回终止事件携带的最终助手消息。 */
	result(): Promise<AssistantMessage>;
}

/** 底层模型 API 的统一流式调用边界。 */
export interface Api {
	/** 用于在模型元数据中选择该 API 的唯一标识。 */
	readonly id: string;
	/** 使用指定模型、上下文和选项发起一次流式调用。 */
	stream(model: Model, context: Context, options?: StreamOptions): StreamResult;
}

/** 对外暴露模型目录和统一流式调用能力的 Provider 适配器。 */
export interface Provider {
	/** Provider 的唯一标识。 */
	readonly id: string;
	/** 面向用户展示的 Provider 名称。 */
	readonly name: string;
	/** 当前 Provider 可用的模型元数据。 */
	readonly models: readonly Model[];
	/** 使用指定模型、上下文和选项发起一次流式调用。 */
	stream(model: Model, context: Context, options?: StreamOptions): StreamResult;
}
