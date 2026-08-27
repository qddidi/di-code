import type {
	AssistantContent,
	FailedAssistantMessage,
	FailedStopReason,
	Model,
	Provider,
	SuccessfulAssistantMessage,
	SuccessfulStopReason,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";

/** 描述一次预先编排的模型结果，由 faux provider 转换为合法的流事件。 */
export type FauxResponse =
	| {
			type: "success";
			content: AssistantContent[];
			stopReason?: SuccessfulStopReason;
	  }
	| {
			type: "failure";
			errorMessage: string;
	  };

/** 创建 faux provider 时使用的确定性输入。 */
export interface FauxProviderOptions {
	/** 每次 stream() 调用按先进先出顺序消费一条响应。 */
	responses: readonly FauxResponse[];
	/** 每条 delta 包含的最大 JavaScript 字符单元数，默认值为 4。 */
	chunkSize?: number;
	/** 注入时间来源，便于生成稳定的消息时间戳。 */
	now?: () => number;
}

/** 将配套的 provider、固定模型和响应队列状态组合为一组对象。 */
export interface FauxProviderHandle {
	readonly provider: Provider;
	readonly model: Model;
	/** 返回尚未被 stream() 领取的响应数量。 */
	pendingResponses(): number;
}

// 规范化后，成功响应一定有停止原因，事件生产器无需在运行途中再次处理缺省值。
type NormalizedResponse =
	| {
			type: "success";
			content: AssistantContent[];
			stopReason: SuccessfulStopReason;
	  }
	| {
			type: "failure";
			errorMessage: string;
	  };

// 取消时只把已经安全形成的内容写入失败消息。
interface ProducerProgress {
	completedContent: AssistantContent[];
	// 半截文本仍可展示；半截工具参数不是合法对象，因此不会记录在这里。
	activePartial?: { type: "text"; text: string } | { type: "thinking"; thinking: string };
}

// Faux 模型不对应任何真实服务，固定元数据用于消除外部配置带来的不确定性。
const FAUX_MODEL: Model = {
	id: "faux-model",
	name: "Faux Model",
	provider: "faux",
	api: "faux",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 128_000,
	maxOutputTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** 为每条消息创建独立的全零 usage，避免调用方修改共享对象。 */
function createZeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** 补齐停止原因，并尽早拒绝内容与停止原因相互矛盾的脚本。 */
function normalizeResponse(response: FauxResponse): NormalizedResponse {
	if (response.type === "failure") {
		return { ...response };
	}

	const hasToolCall = response.content.some((block) => block.type === "tool_call");
	if (hasToolCall && response.stopReason !== undefined && response.stopReason !== "tool_use") {
		throw new Error("tool_call content requires stopReason tool_use");
	}
	if (!hasToolCall && response.stopReason === "tool_use") {
		throw new Error("stopReason tool_use requires tool_call content");
	}

	return {
		...response,
		content: [...response.content],
		stopReason: response.stopReason ?? (hasToolCall ? "tool_use" : "stop"),
	};
}

/** 按固定字符数分块；空字符串不会产生无意义的空 delta。 */
function splitIntoChunks(value: string, chunkSize: number): string[] {
	const chunks: string[] = [];
	for (let offset = 0; offset < value.length; offset += chunkSize) {
		chunks.push(value.slice(offset, offset + chunkSize));
	}
	return chunks;
}

function createSuccessMessage(
	model: Model,
	content: AssistantContent[],
	stopReason: SuccessfulStopReason,
	timestamp: number,
): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content: [...content],
		provider: model.provider,
		model: model.id,
		usage: createZeroUsage(),
		timestamp,
		stopReason,
	};
}

function createFailureMessage(
	model: Model,
	content: AssistantContent[],
	stopReason: FailedStopReason,
	errorMessage: string,
	timestamp: number,
): FailedAssistantMessage {
	return {
		role: "assistant",
		content: [...content],
		provider: model.provider,
		model: model.id,
		usage: createZeroUsage(),
		timestamp,
		stopReason,
		errorMessage,
	};
}

/** 把高层 AssistantContent 逐块翻译成通过状态机校验的流事件。 */
async function produceSuccessResponse(
	response: Extract<NormalizedResponse, { type: "success" }>,
	model: Model,
	chunkSize: number,
	now: () => number,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	signal: AbortSignal | undefined,
	progress: ProducerProgress,
): Promise<void> {
	for (const [contentIndex, block] of response.content.entries()) {
		// 每个内容块开始前检查一次，避免取消后再开启新的块。
		if (isAborted(signal)) {
			pushFailure(stream, model, now, progress, "aborted", "Faux request aborted");
			return;
		}

		switch (block.type) {
			case "text": {
				stream.push({ type: "text_start", contentIndex });
				let partial = "";
				progress.activePartial = { type: "text", text: partial };
				for (const delta of splitIntoChunks(block.text, chunkSize)) {
					stream.push({ type: "text_delta", contentIndex, delta });
					// 先记录已经发出的内容，取消消息才能准确保留当前片段。
					partial += delta;
					progress.activePartial = { type: "text", text: partial };
					await yieldToConsumer();
					if (isAborted(signal)) {
						pushFailure(stream, model, now, progress, "aborted", "Faux request aborted");
						return;
					}
				}
				stream.push({ type: "text_end", contentIndex, content: block.text });
				// 只有 end 成功入流后，这个块才算完整内容。
				progress.completedContent.push({ type: "text", text: block.text });
				progress.activePartial = undefined;
				break;
			}
			case "thinking": {
				stream.push({ type: "thinking_start", contentIndex });
				let partial = "";
				progress.activePartial = { type: "thinking", thinking: partial };
				for (const delta of splitIntoChunks(block.thinking, chunkSize)) {
					stream.push({ type: "thinking_delta", contentIndex, delta });
					partial += delta;
					progress.activePartial = { type: "thinking", thinking: partial };
					await yieldToConsumer();
					if (isAborted(signal)) {
						pushFailure(stream, model, now, progress, "aborted", "Faux request aborted");
						return;
					}
				}
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking });
				// 与文本相同，完成块和活动片段必须互斥。
				progress.completedContent.push({ type: "thinking", thinking: block.thinking });
				progress.activePartial = undefined;
				break;
			}
			case "image": {
				// Keep binary output atomic so cancellation cannot persist a corrupt image.
				stream.push({ type: "image", contentIndex, image: block });
				progress.completedContent.push(block);
				await yieldToConsumer();
				break;
			}
			case "tool_call": {
				stream.push({
					type: "tool_call_start",
					contentIndex,
					id: block.id,
					name: block.name,
				});
				// 单个 delta 可以是半截 JSON；只对完整参数对象序列化一次，再切分字符串。
				const argumentsJson = JSON.stringify(block.arguments);
				if (argumentsJson === undefined) {
					throw new TypeError("Faux tool arguments must be JSON-serializable");
				}
				for (const argumentsDelta of splitIntoChunks(argumentsJson, chunkSize)) {
					stream.push({ type: "tool_call_delta", contentIndex, argumentsDelta });
					await yieldToConsumer();
					if (isAborted(signal)) {
						pushFailure(stream, model, now, progress, "aborted", "Faux request aborted");
						return;
					}
				}
				stream.push({ type: "tool_call_end", contentIndex, toolCall: block });
				// 未到 tool_call_end 的参数不完整，取消时不能进入最终消息或被执行。
				progress.completedContent.push(block);
				break;
			}
		}
	}

	// 最后一个内容块结束后仍可能收到取消，需在 done 前再检查一次。
	if (isAborted(signal)) {
		pushFailure(stream, model, now, progress, "aborted", "Faux request aborted");
		return;
	}

	const message = createSuccessMessage(model, response.content, response.stopReason, now());
	stream.push({ type: "done", reason: response.stopReason, message });
}

/** 合并完整块与当前安全片段，且始终返回新数组。 */
function getPartialContent(progress: ProducerProgress): AssistantContent[] {
	return progress.activePartial
		? [...progress.completedContent, progress.activePartial]
		: [...progress.completedContent];
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** 通过协议内 error 结束请求；event.reason 必须与 message.stopReason 一致。 */
function pushFailure(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model,
	now: () => number,
	progress: ProducerProgress,
	stopReason: FailedStopReason,
	errorMessage: string,
): void {
	const message = createFailureMessage(model, getPartialContent(progress), stopReason, errorMessage, now());
	stream.push({ type: "error", reason: stopReason, message });
}

/**
 * 让消费者处理已经入队的事件，再继续生产下一条 delta。
 * 一次 Promise 微任务不足以让消费者依次处理 start、内容 start 和首个 delta。
 */
async function yieldToConsumer(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * 创建一个不访问网络的可脚本化 Provider。
 * stream() 同步返回事件流，实际事件生产器通过微任务异步启动。
 */
export function createFauxProvider(options: FauxProviderOptions): FauxProviderHandle {
	const chunkSize = options.chunkSize ?? 4;
	if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
		throw new RangeError("chunkSize must be a positive integer");
	}

	const now = options.now ?? Date.now;
	// map 同时复制调用方数组，内部 shift 不会修改原始 responses。
	const responses = options.responses.map(normalizeResponse);
	const model = FAUX_MODEL;

	const provider: Provider = {
		id: "faux",
		name: "Faux Provider",
		models: [model],
		stream(requestedModel, _context, streamOptions) {
			// 在同步阶段领取响应，连续调用会立刻占用不同的 FIFO 项。
			const response = responses.shift() ?? {
				type: "failure",
				errorMessage: "No faux response scripted",
			};
			const stream = createAssistantMessageEventStream();
			const progress: ProducerProgress = { completedContent: [] };

			// Provider 契约要求同步返回 StreamResult，因此只把事件生产安排到微任务。
			queueMicrotask(() => {
				// 成功、失败、队列耗尽和预取消都共享同一个首事件。
				stream.push({ type: "start" });

				if (isAborted(streamOptions?.signal)) {
					pushFailure(stream, requestedModel, now, progress, "aborted", "Faux request aborted");
					return;
				}

				if (response.type === "failure") {
					pushFailure(stream, requestedModel, now, progress, "error", response.errorMessage);
					return;
				}

				void produceSuccessResponse(
					response,
					requestedModel,
					chunkSize,
					now,
					stream,
					streamOptions?.signal,
					progress,
				).catch((cause: unknown) => {
					try {
						// 生产过程中的错误优先转换为稳定的协议内失败，不泄漏任意异常文本。
						pushFailure(stream, requestedModel, now, progress, "error", "Faux producer failed");
					} catch {
						// 若状态机也拒绝错误事件，说明流基础设施已损坏，只能让 result() reject。
						stream.fail(cause);
					}
				});
			});

			return stream;
		},
	};

	return {
		provider,
		model,
		pendingResponses() {
			return responses.length;
		},
	};
}
