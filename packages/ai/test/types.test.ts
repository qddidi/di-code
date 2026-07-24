import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	Api,
	AssistantMessage,
	ContentBlock,
	Message,
	Provider,
	Static,
	StreamEvent,
	StreamResult,
	ToolDefinition,
} from "../src/index.js";
import { Type } from "../src/index.js";

function assertNever(value: never): never {
	throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
describe("ToolDefinition", () => {
	it("preserves the concrete TypeBox schema", () => {
		const parameters = Type.Object({
			expression: Type.String({ minLength: 1 }),
		});

		const tool = {
			name: "calculate",
			description: "Evaluate an arithmetic expression",
			parameters,
		} satisfies ToolDefinition<typeof parameters>;

		type CalculateInput = Static<typeof parameters>;

		expectTypeOf<CalculateInput>().toMatchTypeOf<{ expression: string }>();
		expectTypeOf(tool.parameters).toEqualTypeOf<typeof parameters>();
		expect(tool.name).toBe("calculate");
	});
});

function describeMessage(message: Message): string {
	switch (message.role) {
		case "user":
			return `user:${message.content.length}`;
		case "assistant":
			return `assistant:${message.stopReason}`;
		case "tool_result":
			return `tool:${message.toolName}`;
		default:
			return assertNever(message);
	}
}

function describeContent(content: ContentBlock): string {
	switch (content.type) {
		case "text":
			return content.text;
		case "thinking":
			return content.thinking;
		case "image":
			return content.mimeType;
		case "tool_call":
			return content.name;
		default:
			return assertNever(content);
	}
}

// @ts-expect-error - system prompt belongs to Context.systemPrompt, not Message.
const invalidMessage: Message = { role: "system", content: [], timestamp: 0 };
void invalidMessage;

function eventName(event: StreamEvent): string {
	switch (event.type) {
		case "start":
			return event.type;
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "tool_call_start":
		case "tool_call_delta":
		case "tool_call_end":
			return `${event.type}:${event.contentIndex}`;
		case "done":
		case "error":
			return `${event.type}:${event.reason}`;
		default:
			return assertNever(event);
	}
}
const successfulMessage = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	provider: "faux",
	model: "faux-model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
} satisfies AssistantMessage;

const doneEvent = {
	type: "done",
	reason: "stop",
	message: successfulMessage,
} satisfies StreamEvent;
describe("discriminated union helpers", () => {
	it("handles representative message, content, and event members", () => {
		expect(
			describeMessage({
				role: "user",
				content: [{ type: "text", text: "hello" }],
				timestamp: 1,
			}),
		).toBe("user:1");

		expect(describeContent({ type: "thinking", thinking: "reason" })).toBe("reason");
		expect(eventName(doneEvent)).toBe("done:stop");
	});
});
const streamResult: StreamResult = {
	async *[Symbol.asyncIterator]() {
		yield doneEvent;
	},
	async result() {
		return successfulMessage;
	},
};

const api: Api = {
	id: "faux",
	stream(_model, _context, _options) {
		return streamResult;
	},
};

const provider: Provider = {
	id: "faux",
	name: "Faux",
	models: [],
	stream(model, context, options) {
		return api.stream(model, context, options);
	},
};

expect(provider.id).toBe("faux");
expect(provider.models).toEqual([]);
