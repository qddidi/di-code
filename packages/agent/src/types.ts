import type { AssistantMessage, Message, Model, Provider, StreamEvent, UserMessage } from "@di-code/ai";

/** Agent 可接收、生成并保存在对话历史中的通用消息。 */
export type AgentMessage = Message;

/** 启动新一轮 Agent Loop 时使用的只读对话输入。 */
export interface AgentContext {
	/** 发送给模型但不作为普通消息写入历史的系统提示词。 */
	systemPrompt?: string;
	/** 当前轮次开始前已经提交的完整消息历史。 */
	messages: Message[];
}

/** 助手消息在流式生成期间供界面展示的轻量快照。 */
export interface AssistantMessagePreview {
	/** 固定为 assistant，用于和其他消息角色进行类型区分。 */
	readonly role: "assistant";
	/** 当前模型所属的 Provider 标识。 */
	readonly provider: string;
	/** 当前生成所使用的模型标识。 */
	readonly model: string;
	/** 截至当前增量已经拼接完成的助手文本。 */
	readonly text: string;
}

/** 执行单轮 Agent Loop 所需的外部依赖和运行配置。 */
export interface AgentLoopConfig {
	/** 实际发起流式模型请求的 Provider。 */
	readonly provider: Provider;
	/** 本轮请求使用的模型。 */
	readonly model: Model;
	/** 可注入的时钟，用于为本地构造的失败消息生成确定性时间戳。 */
	readonly now?: () => number;
}

/** 可作为消息增量向 Agent 消费者转发的非起始、非终止 Provider 事件。 */
export type MessageUpdateEvent = Exclude<StreamEvent, { type: "start" | "done" | "error" }>;

/** Agent 从启动到结束按顺序发出的完整生命周期事件。 */
export type AgentEvent =
	/** Agent Loop 已启动，此时尚未开始处理具体轮次。 */
	| { type: "agent_start" }
	/** 一个用户提示对应的模型轮次开始。 */
	| { type: "turn_start" }
	/** 一条用户消息或助手预览开始进入事件流。 */
	| { type: "message_start"; message: UserMessage | AssistantMessagePreview }
	/** 助手消息收到新增量，同时携带原始事件和累计预览。 */
	| { type: "message_update"; event: MessageUpdateEvent; message: AssistantMessagePreview }
	/** 一条用户消息或最终助手消息已完整结束。 */
	| { type: "message_end"; message: UserMessage | AssistantMessage }
	/** 当前模型轮次结束，并给出该轮最终助手消息。 */
	| { type: "turn_end"; message: AssistantMessage }
	/** Agent Loop 的终止事件，携带可一次性提交的完整消息历史。 */
	| { type: "agent_end"; messages: Message[] };
