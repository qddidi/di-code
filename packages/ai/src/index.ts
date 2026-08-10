export type { Static, TSchema } from "typebox";
export { Type } from "typebox";
export type { FauxProviderHandle, FauxProviderOptions, FauxResponse } from "./providers/faux.ts";
export { createFauxProvider } from "./providers/faux.ts";
export type {
	Api,
	AssistantContent,
	AssistantMessage,
	ContentBlock,
	Context,
	FailedAssistantMessage,
	FailedStopReason,
	ImageContent,
	Message,
	Model,
	ModelCost,
	ModelInput,
	Provider,
	StopReason,
	StreamEvent,
	StreamOptions,
	StreamResult,
	SuccessfulAssistantMessage,
	SuccessfulStopReason,
	TextContent,
	ThinkingContent,
	ToolCallContent,
	ToolDefinition,
	ToolResultContent,
	ToolResultMessage,
	Usage,
	UsageCost,
	UserContent,
	UserMessage,
} from "./types.ts";
export type { AssistantMessageEventStream, EventStreamOptions } from "./utils/event-stream.ts";
export { createAssistantMessageEventStream, EventStream } from "./utils/event-stream.ts";
export type { StreamEventValidator } from "./utils/validation.ts";
export {
	createStreamEventValidator,
	parseToolArguments,
	StreamSequenceError,
	ToolArgumentsValidationError,
	validateToolArguments,
} from "./utils/validation.ts";
