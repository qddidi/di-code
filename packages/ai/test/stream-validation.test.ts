import { describe, expect, it } from "vitest";
import type {
	AssistantContent,
	FailedAssistantMessage,
	FailedStopReason,
	StreamEvent,
	SuccessfulAssistantMessage,
	SuccessfulStopReason,
	Usage,
} from "../src/types.js";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.js";
import type { StreamEventValidator } from "../src/utils/validation.js";
import { createStreamEventValidator, StreamSequenceError } from "../src/utils/validation.js";

function createOpenTool(argumentsJson: string): StreamEventValidator {
	const validator = createStreamEventValidator();
	validator.accept({ type: "start" });
	validator.accept({ type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" });
	validator.accept({ type: "tool_call_delta", contentIndex: 0, argumentsDelta: argumentsJson });
	return validator;
}
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
async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function createSuccessMessage(
	content: AssistantContent[],
	stopReason: SuccessfulStopReason = "stop",
): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "faux",
		model: "faux-model",
		usage: createZeroUsage(),
		timestamp: 0,
		stopReason,
	};
}

function createFailureMessage(
	content: AssistantContent[],
	stopReason: FailedStopReason = "error",
): FailedAssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "faux",
		model: "faux-model",
		usage: createZeroUsage(),
		timestamp: 0,
		stopReason,
		errorMessage: "model failed",
	};
}
describe("StreamEventValidator", () => {
	it("requires start as the first event", () => {
		const validator = createStreamEventValidator();

		expect(() => validator.accept({ type: "text_delta", contentIndex: 0, delta: "hello" })).toThrow(
			StreamSequenceError,
		);
	});

	it("rejects a second start event", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });

		expect(() => validator.accept({ type: "start" })).toThrow(/start.*only once/i);
	});
	it("accepts tool arguments split across arbitrary delta boundaries", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" });
		validator.accept({ type: "tool_call_delta", contentIndex: 0, argumentsDelta: '{"path":"README' });
		validator.accept({ type: "tool_call_delta", contentIndex: 0, argumentsDelta: '.md"}' });

		expect(() =>
			validator.accept({
				type: "tool_call_end",
				contentIndex: 0,
				toolCall: { type: "tool_call", id: "call-1", name: "read", arguments: { path: "README.md" } },
			}),
		).not.toThrow();
	});

	it("accepts an empty argument object without any delta events", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" });

		expect(() =>
			validator.accept({
				type: "tool_call_end",
				contentIndex: 0,
				toolCall: { type: "tool_call", id: "call-1", name: "read", arguments: {} },
			}),
		).not.toThrow();
	});

	it("rejects incomplete tool argument JSON at tool_call_end", () => {
		const validator = createOpenTool('{"path"');

		expect(() =>
			validator.accept({
				type: "tool_call_end",
				contentIndex: 0,
				toolCall: { type: "tool_call", id: "call-1", name: "read", arguments: {} },
			}),
		).toThrow(/valid JSON/i);
	});

	it("rejects null and array tool argument roots", () => {
		const nullValidator = createOpenTool("null");
		const arrayValidator = createOpenTool("[]");
		const end = { type: "tool_call", id: "call-1", name: "read", arguments: {} } as const;

		expect(() => nullValidator.accept({ type: "tool_call_end", contentIndex: 0, toolCall: end })).toThrow(
			/JSON object/i,
		);
		expect(() => arrayValidator.accept({ type: "tool_call_end", contentIndex: 0, toolCall: end })).toThrow(
			/JSON object/i,
		);
	});

	it("rejects tool id or name changes between start and end", () => {
		const wrongId = createOpenTool("{}");
		const wrongName = createOpenTool("{}");

		expect(() =>
			wrongId.accept({
				type: "tool_call_end",
				contentIndex: 0,
				toolCall: { type: "tool_call", id: "call-2", name: "read", arguments: {} },
			}),
		).toThrow(/tool id/i);
		expect(() =>
			wrongName.accept({
				type: "tool_call_end",
				contentIndex: 0,
				toolCall: { type: "tool_call", id: "call-1", name: "write", arguments: {} },
			}),
		).toThrow(/tool name/i);
	});

	it("rejects final arguments that differ from accumulated deltas", () => {
		const validator = createOpenTool('{"path":"A"}');

		expect(() =>
			validator.accept({
				type: "tool_call_end",
				contentIndex: 0,
				toolCall: { type: "tool_call", id: "call-1", name: "read", arguments: { path: "B" } },
			}),
		).toThrow(/arguments.*match/i);
	});

	it("rejects a tool delta for the wrong contentIndex", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" });

		expect(() => validator.accept({ type: "tool_call_delta", contentIndex: 1, argumentsDelta: "{}" })).toThrow(
			/expected contentIndex 0.*received 1/i,
		);
	});
	it("requires text_start before text_delta", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });

		expect(() => validator.accept({ type: "text_delta", contentIndex: 0, delta: "hi" })).toThrow(/text.*active/i);
	});

	it("requires the next consecutive contentIndex", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });

		expect(() => validator.accept({ type: "text_start", contentIndex: 1 })).toThrow(
			/expected contentIndex 0.*received 1/i,
		);
	});

	it("rejects a thinking delta while a text block is active", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "text_start", contentIndex: 0 });

		expect(() => validator.accept({ type: "thinking_delta", contentIndex: 0, delta: "hmm" })).toThrow(
			/expected active thinking/i,
		);
	});

	it("rejects text_end when content differs from accumulated deltas", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "text_start", contentIndex: 0 });
		validator.accept({ type: "text_delta", contentIndex: 0, delta: "hello" });

		expect(() => validator.accept({ type: "text_end", contentIndex: 0, content: "bye" })).toThrow(/end content/i);
	});

	it("accepts consecutive text and thinking blocks", () => {
		const validator = createStreamEventValidator();

		expect(() => {
			validator.accept({ type: "start" });
			validator.accept({ type: "text_start", contentIndex: 0 });
			validator.accept({ type: "text_delta", contentIndex: 0, delta: "hello" });
			validator.accept({ type: "text_end", contentIndex: 0, content: "hello" });
			validator.accept({ type: "thinking_start", contentIndex: 1 });
			validator.accept({ type: "thinking_delta", contentIndex: 1, delta: "hmm" });
			validator.accept({ type: "thinking_end", contentIndex: 1, content: "hmm" });
		}).not.toThrow();
	});
	it("accepts done after all blocks have ended", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "text_start", contentIndex: 0 });
		validator.accept({ type: "text_delta", contentIndex: 0, delta: "ok" });
		validator.accept({ type: "text_end", contentIndex: 0, content: "ok" });

		expect(() =>
			validator.accept({
				type: "done",
				reason: "stop",
				message: createSuccessMessage([{ type: "text", text: "ok" }]),
			}),
		).not.toThrow();
	});

	it("allows error to preserve partial text", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "text_start", contentIndex: 0 });
		validator.accept({ type: "text_delta", contentIndex: 0, delta: "par" });

		expect(() =>
			validator.accept({
				type: "error",
				reason: "aborted",
				message: createFailureMessage([{ type: "text", text: "par" }], "aborted"),
			}),
		).not.toThrow();
	});

	it("omits an incomplete tool call from an error message", () => {
		const validator = createOpenTool('{"path"');

		expect(() =>
			validator.accept({ type: "error", reason: "aborted", message: createFailureMessage([], "aborted") }),
		).not.toThrow();
	});

	it("rejects done while a content block is still active", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "text_start", contentIndex: 0 });

		expect(() => validator.accept({ type: "done", reason: "stop", message: createSuccessMessage([]) })).toThrow(
			/active block/i,
		);
	});

	it("requires terminal reason to match message.stopReason", () => {
		const doneValidator = createStreamEventValidator();
		doneValidator.accept({ type: "start" });
		const errorValidator = createStreamEventValidator();
		errorValidator.accept({ type: "start" });

		expect(() =>
			doneValidator.accept({ type: "done", reason: "stop", message: createSuccessMessage([], "length") }),
		).toThrow(/stopReason/i);
		expect(() =>
			errorValidator.accept({ type: "error", reason: "error", message: createFailureMessage([], "aborted") }),
		).toThrow(/stopReason/i);
	});

	it("requires terminal message content to match streamed content", () => {
		const doneValidator = createStreamEventValidator();
		doneValidator.accept({ type: "start" });
		doneValidator.accept({ type: "text_start", contentIndex: 0 });
		doneValidator.accept({ type: "text_delta", contentIndex: 0, delta: "done" });
		doneValidator.accept({ type: "text_end", contentIndex: 0, content: "done" });
		const errorValidator = createStreamEventValidator();
		errorValidator.accept({ type: "start" });
		errorValidator.accept({ type: "text_start", contentIndex: 0 });
		errorValidator.accept({ type: "text_delta", contentIndex: 0, delta: "partial" });

		expect(() => doneValidator.accept({ type: "done", reason: "stop", message: createSuccessMessage([]) })).toThrow(
			/message content/i,
		);
		expect(() => errorValidator.accept({ type: "error", reason: "error", message: createFailureMessage([]) })).toThrow(
			/message content/i,
		);
	});

	it("rejects every event after a terminal event", () => {
		const validator = createStreamEventValidator();
		validator.accept({ type: "start" });
		validator.accept({ type: "done", reason: "stop", message: createSuccessMessage([]) });

		expect(() => validator.accept({ type: "start" })).toThrow(/phase "terminal"/i);
	});
});
describe("AssistantMessage EventStream integration", () => {
	it("yields a legal text sequence and resolves its final message", async () => {
		const stream = createAssistantMessageEventStream();
		const message = createSuccessMessage([{ type: "text", text: "hello" }]);
		stream.push({ type: "start" });
		stream.push({ type: "text_start", contentIndex: 0 });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "hello" });
		stream.push({ type: "text_end", contentIndex: 0, content: "hello" });
		stream.push({ type: "done", reason: "stop", message });

		await expect(collectEvents(stream)).resolves.toHaveLength(5);
		await expect(stream.result()).resolves.toBe(message);
	});

	it("propagates one sequence error to producer, iterator, and result", async () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start" });
		const result = stream.result();
		let failure: unknown;

		try {
			stream.push({ type: "text_delta", contentIndex: 0, delta: "missing text_start" });
		} catch (cause) {
			failure = cause;
		}
		if (!failure) {
			failure = new Error("validator was not called");
			stream.fail(failure);
		}

		expect(failure).toBeInstanceOf(StreamSequenceError);
		await expect(collectEvents(stream)).rejects.toBe(failure);
		await expect(result).rejects.toBe(failure);
	});

	it("resolves an in-protocol error terminal message", async () => {
		const stream = createAssistantMessageEventStream();
		const message = createFailureMessage([], "error");
		stream.push({ type: "start" });
		stream.push({ type: "error", reason: "error", message });

		await expect(stream.result()).resolves.toBe(message);
	});

	it("creates independent validator state for every stream", async () => {
		const first = createAssistantMessageEventStream();
		const second = createAssistantMessageEventStream();
		first.push({ type: "start" });
		second.push({ type: "start" });
		first.push({ type: "done", reason: "stop", message: createSuccessMessage([]) });
		second.push({ type: "done", reason: "stop", message: createSuccessMessage([]) });

		await expect(first.result()).resolves.toMatchObject({ stopReason: "stop" });
		await expect(second.result()).resolves.toMatchObject({ stopReason: "stop" });
	});
});
