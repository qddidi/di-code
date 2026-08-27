import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { AssistantContent, ImageContent, StreamEvent, ToolDefinition } from "../types.ts";

type StreamPhase = "idle" | "streaming" | "terminal";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// 同一时刻只允许一个活动内容块。文本/思考累积可展示字符串，工具调用累积尚未完成的 JSON。
type ActiveBlock =
	| { kind: "text"; contentIndex: number; value: string }
	| { kind: "thinking"; contentIndex: number; value: string }
	| {
			kind: "tool_call";
			contentIndex: number;
			id: string;
			name: string;
			argumentsJson: string;
			sawArgumentsDelta: boolean;
	  };

interface SequenceState {
	phase: StreamPhase;
	// contentIndex 是最终消息 content 数组的下标，只在一个块完整结束后递增。
	nextContentIndex: number;
	activeBlock?: ActiveBlock;
	completedContent: AssistantContent[];
}

/** 表示单个事件类型正确，但它在当前流中的出现顺序不合法。 */
export class StreamSequenceError extends Error {
	readonly eventType: StreamEvent["type"];
	readonly phase: StreamPhase;

	constructor(eventType: StreamEvent["type"], phase: StreamPhase, detail: string) {
		super(`Invalid stream event "${eventType}" in phase "${phase}": ${detail}`);
		this.name = "StreamSequenceError";
		this.eventType = eventType;
		this.phase = phase;
	}
}

export interface StreamEventValidator {
	/** 接受并校验下一个事件；协议顺序错误时同步抛出 StreamSequenceError。 */
	accept(event: StreamEvent): void;
}

function reject(event: StreamEvent, state: SequenceState, detail: string): never {
	throw new StreamSequenceError(event.type, state.phase, detail);
}

function assertStartIndex(event: StreamEvent, state: SequenceState, received: number): void {
	if (received !== state.nextContentIndex) {
		reject(event, state, `expected contentIndex ${state.nextContentIndex}, received ${received}`);
	}
}
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// 工具参数只能包含 JSON 可表达的数据，排除函数、undefined、Date、Map 和无限数值。
function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return false;
		}
		return Object.values(value as Record<string, unknown>).every(isJsonValue);
	}
	return false;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function isImageContent(value: unknown): value is ImageContent {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>;
	const data = typeof image.data === "string" ? image.data : "";
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const decodedBytes = Math.floor((data.length * 3) / 4) - padding;
	return (
		image.type === "image" &&
		data.length > 0 &&
		data.length % 4 === 0 &&
		/^[A-Za-z0-9+/]*={0,2}$/.test(data) &&
		decodedBytes > 0 &&
		decodedBytes <= MAX_IMAGE_BYTES &&
		typeof image.mimeType === "string" &&
		/^image\/[A-Za-z0-9.+-]+$/.test(image.mimeType)
	);
}

// JSON.parse 会创建新对象，因此这里比较结构和值，不能使用 === 比较对象引用。
function jsonDeepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => jsonDeepEqual(value, right[index]))
		);
	}
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
		return false;
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) => key === rightKeys[index] && jsonDeepEqual(leftRecord[key], rightRecord[key]))
	);
}
function getExpectedTerminalContent(state: SequenceState): AssistantContent[] {
	const content = [...state.completedContent];
	const active = state.activeBlock;
	// error 可以中断文本和思考并保留已有片段；半截工具 JSON 不能伪装成可执行工具调用。
	if (active?.kind === "text") {
		content.push({ type: "text", text: active.value });
	}
	if (active?.kind === "thinking") {
		content.push({ type: "thinking", thinking: active.value });
	}
	return content;
}

/** 为一条模型流创建独立的顺序校验器，避免并发请求共享状态。 */
export function createStreamEventValidator(): StreamEventValidator {
	const state: SequenceState = {
		phase: "idle",
		nextContentIndex: 0,
		completedContent: [],
	};

	return {
		accept(event) {
			// start 是唯一能让状态机从 idle 进入 streaming 的事件。
			if (state.phase === "idle") {
				if (event.type !== "start") {
					reject(event, state, 'expected "start" as the first event');
				}
				state.phase = "streaming";
				return;
			}
			if (state.phase === "terminal") {
				reject(event, state, "no events are allowed after a terminal event");
			}
			if (event.type === "start") {
				reject(event, state, '"start" may appear only once');
			}

			switch (event.type) {
				case "text_start":
				case "thinking_start": {
					// 新块必须使用下一个连续下标，并且不能与另一个未结束块交错。
					if (state.activeBlock) {
						reject(event, state, `cannot start a new block while ${state.activeBlock.kind} is active`);
					}
					assertStartIndex(event, state, event.contentIndex);
					state.activeBlock = {
						kind: event.type === "text_start" ? "text" : "thinking",
						contentIndex: event.contentIndex,
						value: "",
					};
					return;
				}
				case "text_delta":
				case "thinking_delta": {
					// delta 只能追加到类型和 contentIndex 都匹配的当前活动块。
					const expectedKind = event.type === "text_delta" ? "text" : "thinking";
					const active = state.activeBlock;
					if (!active || active.kind === "tool_call" || active.kind !== expectedKind) {
						reject(event, state, `expected active ${expectedKind} block`);
					}
					if (event.contentIndex !== active.contentIndex) {
						reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
					}
					active.value += event.delta;
					return;
				}
				case "text_end":
				case "thinking_end": {
					// 先完成全部一致性检查，再提交内容并递增下标，避免非法 end 污染状态。
					const expectedKind = event.type === "text_end" ? "text" : "thinking";
					const active = state.activeBlock;
					if (!active || active.kind === "tool_call" || active.kind !== expectedKind) {
						reject(event, state, `expected active ${expectedKind} block`);
					}
					if (event.contentIndex !== active.contentIndex) {
						reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
					}
					if (event.content !== active.value) {
						reject(event, state, "end content does not match accumulated deltas");
					}
					state.completedContent.push(
						expectedKind === "text"
							? { type: "text", text: active.value }
							: { type: "thinking", thinking: active.value },
					);
					state.activeBlock = undefined;
					state.nextContentIndex += 1;
					return;
				}
				case "image": {
					// Images are deliberately atomic: an incomplete binary payload must never enter the message history.
					if (state.activeBlock) {
						reject(event, state, `cannot emit an image while ${state.activeBlock.kind} is active`);
					}
					assertStartIndex(event, state, event.contentIndex);
					if (!isImageContent(event.image)) reject(event, state, "image content is invalid");
					state.completedContent.push(event.image);
					state.nextContentIndex += 1;
					return;
				}
				case "tool_call_start": {
					// start 只记录工具身份；参数要等后续 delta 到达后再逐段拼接。
					if (state.activeBlock) {
						reject(event, state, `cannot start a new block while ${state.activeBlock.kind} is active`);
					}
					assertStartIndex(event, state, event.contentIndex);
					state.activeBlock = {
						kind: "tool_call",
						contentIndex: event.contentIndex,
						id: event.id,
						name: event.name,
						argumentsJson: "",
						sawArgumentsDelta: false,
					};
					return;
				}
				case "tool_call_delta": {
					const active = state.activeBlock;
					if (!active || active.kind !== "tool_call") {
						reject(event, state, "expected active tool_call block");
					}
					if (event.contentIndex !== active.contentIndex) {
						reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
					}
					// 单个 delta 往往不是合法 JSON，因此此处只拼字符串，不调用 JSON.parse。
					active.sawArgumentsDelta = true;
					active.argumentsJson += event.argumentsDelta;
					return;
				}
				case "tool_call_end": {
					const active = state.activeBlock;
					if (!active || active.kind !== "tool_call") {
						reject(event, state, "expected active tool_call block");
					}
					if (event.contentIndex !== active.contentIndex) {
						reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
					}

					// 只有 end 才拥有完整参数：有 delta 时解析累积字符串，无 delta 时使用 end 自带对象。
					let parsed: Record<string, JsonValue>;
					if (active.sawArgumentsDelta) {
						let candidate: unknown;
						try {
							candidate = JSON.parse(active.argumentsJson);
						} catch {
							reject(event, state, "tool arguments must be valid JSON");
						}
						if (!isJsonObject(candidate)) {
							reject(event, state, "tool arguments must have a JSON object root");
						}
						parsed = candidate;
					} else {
						if (!isJsonObject(event.toolCall.arguments)) {
							reject(event, state, "tool arguments must have a JSON object root");
						}
						parsed = event.toolCall.arguments;
					}

					if (event.toolCall.id !== active.id) {
						reject(event, state, `tool id must remain "${active.id}"`);
					}
					if (event.toolCall.name !== active.name) {
						reject(event, state, `tool name must remain "${active.name}"`);
					}
					if (
						!isJsonObject(event.toolCall.arguments) ||
						(active.sawArgumentsDelta && !jsonDeepEqual(parsed, event.toolCall.arguments))
					) {
						reject(event, state, "final tool arguments must match accumulated arguments");
					}

					// 身份、JSON 和最终参数全部一致后，工具块才成为已完成内容。
					state.completedContent.push({
						type: "tool_call",
						id: active.id,
						name: active.name,
						arguments: parsed,
					});
					state.activeBlock = undefined;
					state.nextContentIndex += 1;
					return;
				}
				case "done": {
					// 正常结束必须没有半成品块，并且最终消息要完整复现流中已完成内容。
					if (state.activeBlock) {
						reject(event, state, "done cannot terminate an active block");
					}
					if (event.reason !== event.message.stopReason) {
						reject(event, state, "event reason must match message.stopReason");
					}
					if (!jsonDeepEqual(event.message.content, state.completedContent)) {
						reject(event, state, "done message content must match completed stream content");
					}
					state.phase = "terminal";
					return;
				}
				case "error": {
					// 模型失败或取消可以随时发生，但失败消息只能携带安全的部分内容。
					if (event.reason !== event.message.stopReason) {
						reject(event, state, "event reason must match message.stopReason");
					}
					if (!jsonDeepEqual(event.message.content, getExpectedTerminalContent(state))) {
						reject(event, state, "error message content must match safe partial stream content");
					}
					state.phase = "terminal";
					return;
				}
				default:
					reject(event, state, "event is not implemented at this step");
			}
		},
	};
}
/** 表示一组工具参数无法安全地满足该工具的 TypeBox schema。 */
export class ToolArgumentsValidationError extends Error {
	readonly toolName: string;
	readonly issues: readonly string[];

	constructor(toolName: string, issues: readonly string[]) {
		const details = issues.map((issue) => `  - ${issue}`).join("\n");
		super(`Invalid arguments for tool "${toolName}":\n${details}`);
		this.name = "ToolArgumentsValidationError";
		this.toolName = toolName;
		this.issues = [...issues];
	}
}
function escapeJsonPointerSegment(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function formatValidationIssue(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperty = error.params.requiredProperties[0];
		if (requiredProperty) {
			const segment = escapeJsonPointerSegment(requiredProperty);
			return `${error.instancePath}/${segment}: ${error.message}`;
		}
	}

	const path = error.instancePath || "/";
	return `${path}: ${error.message}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function cloneToolArguments(toolName: string, value: unknown): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw new ToolArgumentsValidationError(toolName, ["/: arguments must be a plain object"]);
	}

	try {
		return structuredClone(value);
	} catch {
		throw new ToolArgumentsValidationError(toolName, [
			"/: arguments must contain only structured-clone-compatible values",
		]);
	}
}
export function validateToolArguments<TParameters extends TSchema>(
	tool: ToolDefinition<TParameters>,
	value: unknown,
): Static<TParameters> {
	const candidate = cloneToolArguments(tool.name, value);
	const validator = Compile(tool.parameters);

	if (validator.Check(candidate)) {
		return candidate;
	}

	const issues = validator.Errors(candidate).map(formatValidationIssue);
	throw new ToolArgumentsValidationError(
		tool.name,
		issues.length > 0 ? issues : ["/: arguments do not satisfy the tool schema"],
	);
}

export function parseToolArguments<TParameters extends TSchema>(
	tool: ToolDefinition<TParameters>,
	json: string,
): Static<TParameters> {
	let value: unknown;
	try {
		value = JSON.parse(json) as unknown;
	} catch {
		throw new ToolArgumentsValidationError(tool.name, ["/: arguments must be valid JSON"]);
	}

	return validateToolArguments(tool, value);
}
