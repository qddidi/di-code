import { describe, expect, it, vi } from "vitest";
import type {
	Context,
	Model,
	OpenAIResponsesDependencies,
	OpenAIResponsesStreamOptions,
	StreamEvent,
	StreamResult,
} from "../src/index.ts";
import * as ai from "../src/index.ts";

type StreamOpenAIResponses = (
	model: Model,
	context: Context,
	options: OpenAIResponsesStreamOptions,
	dependencies?: OpenAIResponsesDependencies,
) => StreamResult;

const streamOpenAIResponses = Reflect.get(ai, "streamOpenAIResponses") as StreamOpenAIResponses;

const model: Model = {
	id: "test-openai-model",
	name: "Test OpenAI Model",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxOutputTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const deepSeekModel: Model = {
	...model,
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	provider: "deepseek",
	api: "deepseek-responses",
	reasoning: true,
	contextWindow: 1_000_000,
	maxOutputTokens: 384_000,
};

const context: Context = {
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }],
};

function sse(...events: readonly unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkedSse(payload: string, splitAt: readonly number[]): Response {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (const end of splitAt) {
		chunks.push(encoder.encode(payload.slice(offset, end)));
		offset = end;
	}
	chunks.push(encoder.encode(payload.slice(offset)));

	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function collect(stream: StreamResult): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function dependencies(response: Response): OpenAIResponsesDependencies & { fetch: ReturnType<typeof vi.fn> } {
	return {
		fetch: vi.fn(async () => response),
		now: () => 1234,
	};
}

const options: OpenAIResponsesStreamOptions = { apiKey: "test-key", temperature: 0, maxTokens: 64 };

describe("streamOpenAIResponses", () => {
	it("ignores Codex response metadata events", async () => {
		const response = sse(
			{
				type: "codex.rate_limits",
				rate_limits: {
					limit_id: "codex",
					primary: null,
					secondary: null,
					credits: null,
				},
			},
			{ type: "codex.response.metadata", metadata: { request_id: "req_test" } },
			{ type: "response.completed", response: { status: "completed" } },
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({ content: [], stopReason: "stop" });
	});

	it("ignores unsupported event types and continues the response stream", async () => {
		const response = sse(
			{ type: "keepalive" },
			{ type: "provider.unrecognized_event" },
			{ type: "response.completed", response: { status: "completed" } },
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({ stopReason: "stop", content: [] });
	});

	it("preserves encrypted reasoning and paired function calls for stateless replay", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_replay", summary: [] },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 0,
				delta: "Use the tool",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 0,
				text: "Use the tool",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "Use the tool" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_replay",
					summary: [{ type: "summary_text", text: "Use the tool" }],
					encrypted_content: "encrypted-replay",
					status: "completed",
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_replay", call_id: "call_replay", name: "bash", arguments: "" },
			},
			{
				type: "response.function_call_arguments.done",
				output_index: 1,
				arguments: '{"command":"Get-Location"}',
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_replay",
					call_id: "call_replay",
					name: "bash",
					arguments: '{"command":"Get-Location"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 4, output_tokens: 5 } },
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [
				{ type: "thinking", thinking: "Use the tool" },
				{ type: "tool_call", id: "call_replay", name: "bash", arguments: { command: "Get-Location" } },
			],
			providerReplay: {
				api: "openai-responses",
				data: {
					outputItems: [
						{
							type: "reasoning",
							id: "rs_replay",
							encrypted_content: "encrypted-replay",
						},
						{
							type: "function_call",
							id: "fc_replay",
							call_id: "call_replay",
						},
					],
				},
			},
			stopReason: "tool_use",
		});
	});

	it("preserves a message replay item when an unencrypted reasoning item cannot be replayed", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_unencrypted", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_unencrypted", summary: [], status: "completed" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_preserved", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Preserve me" },
			{ type: "response.output_text.done", output_index: 1, content_index: 0, text: "Preserve me" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_preserved",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Preserve me", annotations: [] }],
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 2 } } },
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect((await stream.result()).providerReplay).toEqual({
			api: "openai-responses",
			data: {
				outputItems: [
					{
						type: "message",
						id: "msg_preserved",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Preserve me", annotations: [] }],
					},
				],
			},
		});
	});

	it("preserves a function-call replay item when an unencrypted reasoning item cannot be replayed", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_unencrypted", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_unencrypted", summary: [], status: "completed" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_preserved", call_id: "call_preserved", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.done", output_index: 1, arguments: '{"path":"README.md"}' },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_preserved",
					call_id: "call_preserved",
					name: "read",
					arguments: '{"path":"README.md"}',
					status: "completed",
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 2 } } },
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect((await stream.result()).providerReplay).toEqual({
			api: "openai-responses",
			data: {
				outputItems: [
					{
						type: "function_call",
						id: "fc_preserved",
						call_id: "call_preserved",
						name: "read",
						arguments: '{"path":"README.md"}',
						status: "completed",
					},
				],
			},
		});
	});

	it("replays a streamed reasoning tool turn in the next stateless request", async () => {
		const firstResponse = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_round_trip", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_round_trip",
					summary: [],
					encrypted_content: "encrypted-round-trip",
					status: "completed",
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_round_trip", call_id: "call_round_trip", name: "bash" },
			},
			{
				type: "response.function_call_arguments.done",
				output_index: 1,
				arguments: '{"command":"Get-Location"}',
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_round_trip",
					call_id: "call_round_trip",
					name: "bash",
					arguments: '{"command":"Get-Location"}',
					status: "completed",
				},
			},
			{ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4 } } },
		);
		const secondResponse = sse({
			type: "response.completed",
			response: { usage: { input_tokens: 5, output_tokens: 1 } },
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(firstResponse)
			.mockResolvedValueOnce(secondResponse);
		const reasoningModel = { ...model, reasoning: true };
		const firstStream = streamOpenAIResponses(reasoningModel, context, options, { fetch, now: () => 1234 });

		await collect(firstStream);
		const assistant = await firstStream.result();
		const secondContext: Context = {
			...context,
			messages: [
				...context.messages,
				assistant,
				{
					role: "tool_result",
					toolCallId: "call_round_trip",
					toolName: "bash",
					content: [{ type: "text", text: "D:\\pi\\di-code" }],
					isError: false,
					timestamp: 1235,
				},
			],
		};
		const secondStream = streamOpenAIResponses(reasoningModel, secondContext, options, { fetch, now: () => 1236 });
		await collect(secondStream);

		const secondRequest = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};
		expect(secondRequest.input.slice(-3).map((item) => item.type)).toEqual([
			"reasoning",
			"function_call",
			"function_call_output",
		]);
		expect(secondRequest.input.at(-3)).toMatchObject({
			id: "rs_round_trip",
			encrypted_content: "encrypted-round-trip",
		});
	});

	it("replays DeepSeek plain reasoning through a stateless tool turn", async () => {
		const firstResponse = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_deepseek", status: "in_progress", summary: [], content: [] },
			},
			{
				type: "response.reasoning_text.delta",
				output_index: 0,
				content_index: 0,
				delta: "Inspect the workspace",
			},
			{
				type: "response.reasoning_text.done",
				output_index: 0,
				content_index: 0,
				text: "Inspect the workspace",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_deepseek",
					status: "completed",
					summary: [],
					content: [{ type: "reasoning_text", text: "Inspect the workspace" }],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_deepseek", call_id: "call_deepseek", name: "bash" },
			},
			{
				type: "response.function_call_arguments.delta",
				output_index: 1,
				delta: '{"command":"Get-Location"}',
			},
			{
				type: "response.function_call_arguments.done",
				output_index: 1,
				arguments: '{"command":"Get-Location"}',
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_deepseek",
					call_id: "call_deepseek",
					name: "bash",
					arguments: '{"command":"Get-Location"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					output: [
						{
							type: "reasoning",
							id: "rs_deepseek",
							summary: [],
							encrypted_content: "ignored-deepseek-encryption",
							status: "completed",
						},
					],
					usage: {
						input_tokens: 5,
						input_tokens_details: { cached_tokens: 1 },
						output_tokens: 4,
					},
				},
			},
		);
		const secondResponse = sse({
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 7, output_tokens: 1 } },
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(firstResponse)
			.mockResolvedValueOnce(secondResponse);
		const firstStream = streamOpenAIResponses(deepSeekModel, context, options, { fetch, now: () => 1234 });

		await collect(firstStream);
		const assistant = await firstStream.result();
		expect(assistant).toMatchObject({
			content: [
				{ type: "thinking", thinking: "Inspect the workspace" },
				{ type: "tool_call", id: "call_deepseek", name: "bash", arguments: { command: "Get-Location" } },
			],
			provider: "deepseek",
			model: "deepseek-v4-pro",
			stopReason: "tool_use",
			usage: { input: 4, cacheRead: 1, output: 4, totalTokens: 9 },
			providerReplay: { api: "deepseek-responses" },
		});

		const secondContext: Context = {
			...context,
			messages: [
				...context.messages,
				assistant,
				{
					role: "tool_result",
					toolCallId: "call_deepseek",
					toolName: "bash",
					content: [{ type: "text", text: "D:\\pi\\di-code" }],
					isError: false,
					timestamp: 1235,
				},
			],
		};
		const secondStream = streamOpenAIResponses(deepSeekModel, secondContext, options, { fetch, now: () => 1236 });
		await collect(secondStream);

		const secondRequest = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};
		expect(secondRequest.input.slice(-3).map((item) => item.type)).toEqual([
			"reasoning",
			"function_call",
			"function_call_output",
		]);
		expect(secondRequest.input.at(-3)).toEqual({
			type: "reasoning",
			id: "rs_deepseek",
			status: "completed",
			content: [{ type: "reasoning_text", text: "Inspect the workspace" }],
		});
	});

	it("supplements reasoning encryption from the terminal response output", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_late", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_late", summary: [], status: "completed" },
			},
			{
				type: "response.completed",
				response: {
					output: [
						{
							type: "reasoning",
							id: "rs_late",
							summary: [],
							encrypted_content: "encrypted-late",
							status: "completed",
						},
					],
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect((await stream.result()).providerReplay).toMatchObject({
			api: "openai-responses",
			data: { outputItems: [{ id: "rs_late", encrypted_content: "encrypted-late" }] },
		});
	});

	it.each([
		["a missing id and no encryption", {}],
		["a null id and no encryption", { id: null }],
		["a null id and empty encryption", { id: null, encrypted_content: "" }],
	])("ignores a terminal reasoning item with %s", async (_label, terminalFields) => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_done", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_done", summary: [], status: "completed" },
			},
			{
				type: "response.completed",
				response: {
					output: [{ type: "reasoning", summary: [], status: "completed", ...terminalFields }],
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		const result = await stream.result();
		expect(result).toMatchObject({ stopReason: "stop" });
		expect(result).not.toHaveProperty("providerReplay");
	});

	it("rejects terminal reasoning encryption without a usable id", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_done", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_done", summary: [], status: "completed" },
			},
			{
				type: "response.completed",
				response: {
					output: [
						{
							type: "reasoning",
							id: null,
							summary: [],
							encrypted_content: "encrypted-late",
							status: "completed",
						},
					],
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: response.output[0].id must be a string",
		});
	});

	it("maps reasoning summary deltas into a thinking block", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 0,
				delta: "Plan",
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 0,
				delta: " first",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 0,
				text: "Plan first",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "Plan first" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_1",
					summary: [{ type: "summary_text", text: "Plan first" }],
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 2, output_tokens: 3 } },
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		expect((await collect(stream)).map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"done",
		]);
		const result = await stream.result();
		expect(result).toMatchObject({
			content: [{ type: "thinking", thinking: "Plan first" }],
			stopReason: "stop",
		});
		expect(result.providerReplay).toBeUndefined();
	});

	it("keeps a multi-part reasoning summary open until the output item is done", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_multi", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 0,
				delta: "First",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 0,
				text: "First",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "First" },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 1,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 1,
				delta: "Second",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 1,
				text: "Second",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 1,
				part: { type: "summary_text", text: "Second" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_multi",
					summary: [
						{ type: "summary_text", text: "First" },
						{ type: "summary_text", text: "Second" },
					],
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 2, output_tokens: 4 } },
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		const events = await collect(stream);

		expect(events.map(({ type }) => type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"done",
		]);
		expect(events.filter(({ type }) => type === "thinking_delta")).toMatchObject([
			{ delta: "First" },
			{ delta: "\n\n" },
			{ delta: "Second" },
		]);
		expect(await stream.result()).toMatchObject({
			content: [{ type: "thinking", thinking: "First\n\nSecond" }],
			stopReason: "stop",
		});
	});

	it("rejects a reasoning output item that ends before its summary part is done", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_incomplete_part", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 0,
				delta: "unfinished",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 0,
				text: "unfinished",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_incomplete_part",
					summary: [{ type: "summary_text", text: "unfinished" }],
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 2, output_tokens: 2 } },
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "thinking", thinking: "unfinished" }],
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: reasoning output ended before its summary part completed",
		});
	});

	it("preserves the separator after an empty reasoning summary part", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_empty_part", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 0,
				text: "",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 1,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 1,
				delta: "Second",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 1,
				text: "Second",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 1,
				part: { type: "summary_text", text: "Second" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_empty_part",
					summary: [
						{ type: "summary_text", text: "" },
						{ type: "summary_text", text: "Second" },
					],
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 2, output_tokens: 2 } },
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "thinking", thinking: "\n\nSecond" }],
			stopReason: "stop",
		});
	});

	it("rejects a completed reasoning item with an invalid summary part type", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_invalid_summary", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				summary_index: 0,
				delta: "checked",
			},
			{
				type: "response.reasoning_summary_text.done",
				output_index: 0,
				summary_index: 0,
				text: "checked",
			},
			{
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "checked" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_invalid_summary",
					summary: [{ type: "reasoning_text", text: "checked" }],
				},
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "thinking", thinking: "checked" }],
			stopReason: "error",
			errorMessage: 'Invalid OpenAI Responses stream: item.summary[0].type must be "summary_text"',
		});
	});

	it("requires a summary on completed OpenAI reasoning items", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_missing_summary", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_missing_summary",
					encrypted_content: "encrypted-missing-summary",
					status: "completed",
				},
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: item.summary must be an array",
		});
	});

	it("preserves incomplete reasoning when the stream ends early", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_partial", summary: [] },
			},
			{
				type: "response.reasoning_text.delta",
				output_index: 0,
				content_index: 0,
				delta: "private partial",
			},
		);
		const stream = streamOpenAIResponses({ ...model, reasoning: true }, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "thinking", thinking: "private partial" }],
			stopReason: "error",
			errorMessage: "OpenAI Responses stream ended before a terminal response event",
		});
	});

	it("posts the 11a request and maps chunked text, usage, and stop", async () => {
		const payload = [
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.in_progress", response: { id: "resp_1" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hel" },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "lo" },
			{ type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
			{
				type: "response.content_part.done",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "Hello", annotations: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
						input_tokens_details: { cached_tokens: 3 },
					},
				},
			},
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		const deps = dependencies(chunkedSse(payload, [3, 19, 77, 131]));

		const pricedModel: Model = {
			...model,
			cost: { input: 0.000002, output: 0.000008, cacheRead: 0.0000005, cacheWrite: 0 },
		};
		const stream = streamOpenAIResponses(pricedModel, context, options, deps);
		const events = await collect(stream);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(await stream.result()).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			provider: "openai",
			model: "test-openai-model",
			providerReplay: {
				api: "openai-responses",
				data: {
					outputItems: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello", annotations: [] }],
						},
					],
				},
			},
			usage: {
				input: 7,
				output: 2,
				cacheRead: 3,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0.000014, output: 0.000016, cacheRead: 0.0000015, cacheWrite: 0, total: 0.0000315 },
			},
			timestamp: 1234,
			stopReason: "stop",
		});
		expect(deps.fetch).toHaveBeenCalledOnce();
		const [url, init] = deps.fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/responses");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			accept: "text/event-stream",
			authorization: "Bearer test-key",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: "test-openai-model",
			instructions: "Answer briefly.",
			stream: true,
			store: false,
			temperature: 0,
			max_output_tokens: 64,
		});
	});

	it("sends stable session-affinity headers when a session id is supplied", async () => {
		const deps = dependencies(
			sse({
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			}),
		);

		const stream = streamOpenAIResponses(model, context, { ...options, sessionId: "session-affinity-123" }, deps);
		await collect(stream);

		const [, init] = deps.fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({
			session_id: "session-affinity-123",
			"x-client-request-id": "session-affinity-123",
		});
	});

	it("uses the OpenAI session_id header for custom GPT models", async () => {
		const deps = dependencies(
			sse({
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			}),
		);

		const stream = streamOpenAIResponses(
			{ ...model, id: "gpt-5.6-terra", baseUrl: "https://gateway.example/v1" },
			context,
			{ ...options, sessionId: "session-codex-automatic-123" },
			deps,
		);
		await collect(stream);

		const [, init] = deps.fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.headers).toMatchObject({
			session_id: "session-codex-automatic-123",
			"x-client-request-id": "session-codex-automatic-123",
		});
		expect(init.headers).not.toHaveProperty("session-id");
	});

	it("maps function argument deltas and preserves the call id", async () => {
		const response = sse(
			{ type: "response.created", response: { id: "resp_tool" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_7", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"READ' },
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: 'ME.md"}' },
			{
				type: "response.function_call_arguments.done",
				output_index: 0,
				arguments: '{"path":"README.md"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_7",
					name: "read",
					arguments: '{"path":"README.md"}',
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } },
			},
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		const events = await collect(stream);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"tool_call_start",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_end",
			"done",
		]);
		expect(await stream.result()).toMatchObject({
			content: [{ type: "tool_call", id: "call_7", name: "read", arguments: { path: "README.md" } }],
			stopReason: "tool_use",
		});
	});

	it("maps an incomplete response to the length stop reason", async () => {
		const response = sse({
			type: "response.incomplete",
			response: { status: "incomplete", usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 } },
		});
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({ stopReason: "length", content: [] });
	});

	it("turns an HTTP failure into a terminal protocol error without leaking the key", async () => {
		const stream = streamOpenAIResponses(
			model,
			context,
			options,
			dependencies(new Response("secret upstream body", { status: 429 })),
		);

		const events = await collect(stream);
		const result = await stream.result();

		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI request failed with HTTP 429",
		});
		expect(JSON.stringify(result)).not.toContain("test-key");
		expect(JSON.stringify(result)).not.toContain("secret upstream body");
	});

	it("turns response.failed into a terminal protocol error", async () => {
		const response = sse({
			type: "response.failed",
			response: { status: "failed", error: { code: "server_error", message: "Upstream failed" } },
		});
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "server_error: Upstream failed",
		});
	});

	it("maps the top-level error event shape used by Responses", async () => {
		const response = sse({ type: "error", code: "rate_limit_exceeded", message: "Slow down", param: null });
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "rate_limit_exceeded: Slow down",
		});
	});

	it("recovers text when a gateway omits the message output-item start event", async () => {
		const response = sse(
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
			{ type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_recovered",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello", annotations: [] }],
				},
			},
			{ type: "response.completed", response: { status: "completed" } },
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "text", text: "Hello" }],
			stopReason: "stop",
		});
	});

	it("retries a malformed gateway error before any output is received", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(sse({ type: "error", message: null }))
			.mockResolvedValueOnce(
				sse(
					{
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_retry",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Recovered" },
					{ type: "response.output_text.done", output_index: 0, content_index: 0, text: "Recovered" },
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_retry",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Recovered", annotations: [] }],
						},
					},
					{ type: "response.completed", response: { status: "completed" } },
				),
			);
		const stream = streamOpenAIResponses(model, context, options, { fetch, now: () => 1234 });

		await collect(stream);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(await stream.result()).toMatchObject({
			content: [{ type: "text", text: "Recovered" }],
			stopReason: "stop",
		});
	});

	it("normalizes malformed SSE JSON", async () => {
		const response = new Response("data: {not-json}\n\n", { status: 200 });
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: event data must be valid JSON",
		});
	});

	it("preserves partial text when the stream reaches EOF before a terminal event", async () => {
		const response = sse(
			{ type: "response.created", response: { id: "resp_eof" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_eof", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			content: [{ type: "text", text: "partial" }],
			stopReason: "error",
			errorMessage: "OpenAI Responses stream ended before a terminal response event",
		});
	});

	it("aborts a pending stream read and ends with aborted", async () => {
		const abortController = new AbortController();
		const encoder = new TextEncoder();
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_abort" } })}\n\n`,
							),
						);
						const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
						signal?.addEventListener("abort", abort, { once: true });
					},
				}),
				{ status: 200 },
			);
		});
		const stream = streamOpenAIResponses(
			model,
			context,
			{ ...options, signal: abortController.signal },
			{ fetch, now: () => 1234 },
		);
		const eventsPromise = collect(stream);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

		abortController.abort(new Error("private abort reason"));
		await eventsPromise;

		expect(await stream.result()).toMatchObject({
			stopReason: "aborted",
			errorMessage: "OpenAI request aborted",
		});
	});

	it("rejects interleaved output items instead of violating the unified stream", async () => {
		const response = sse(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "read", arguments: "" },
			},
		);
		const stream = streamOpenAIResponses(model, context, options, dependencies(response));

		await collect(stream);

		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "Invalid OpenAI Responses stream: output items must not be interleaved",
		});
	});
});
