import { describe, expect, it } from "vitest";
import {
	type AssistantMessage,
	buildOpenAIResponsesRequest,
	type Context,
	type Model,
	type ProviderReplay,
	Type,
} from "../src/index.ts";

const model: Model = {
	id: "test-openai-model",
	name: "Test OpenAI Model",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	reasoning: false,
	contextWindow: 10_000,
	maxOutputTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const imageModel: Model = { ...model, input: ["text", "image"] };

function textContext(): Context {
	return {
		systemPrompt: "Answer briefly.",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "previous answer" }],
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		],
	};
}

describe("buildOpenAIResponsesRequest", () => {
	it("maps model, instructions, text history, and fixed streaming fields", () => {
		const request = buildOpenAIResponsesRequest(model, textContext());

		expect(request).toEqual({
			model: "test-openai-model",
			instructions: "Answer briefly.",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "first" },
						{ type: "input_text", text: "second" },
					],
				},
				{
					type: "message",
					id: "msg_di_1_0",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "previous answer", annotations: [] }],
				},
			],
			stream: true,
			store: false,
		});
	});

	it("preserves tool call ids across calls and results", () => {
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "tool_call",
							id: "call_read_1",
							name: "read",
							arguments: { path: "README.md" },
						},
					],
					provider: "faux",
					model: "faux-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "tool_use",
					timestamp: 1,
				},
				{
					role: "tool_result",
					toolCallId: "call_read_1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		expect(buildOpenAIResponsesRequest(model, context).input).toEqual([
			{
				type: "function_call",
				call_id: "call_read_1",
				name: "read",
				arguments: '{"path":"README.md"}',
			},
			{
				type: "function_call_output",
				call_id: "call_read_1",
				output: "file contents",
			},
		]);
	});

	it("maps tools and stream options without changing the TypeBox schema", () => {
		const parameters = Type.Object({
			path: Type.String({ minLength: 1 }),
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
		});
		const context: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "read" }], timestamp: 1 }],
			tools: [{ name: "read", description: "Read a text file", parameters }],
		};

		const request = buildOpenAIResponsesRequest(model, context, {
			maxTokens: 300,
			temperature: 0.25,
		});

		expect(request.max_output_tokens).toBe(300);
		expect(request.temperature).toBe(0.25);
		expect(request.tools).toEqual([
			{
				type: "function",
				name: "read",
				description: "Read a text file",
				parameters,
				strict: false,
			},
		]);
		expect(request.tools?.[0]?.parameters).toBe(parameters);
	});

	it("maps a stable session id to a bounded prompt cache key", () => {
		const longSessionId = `session-${"cache".repeat(20)}`;

		const request = buildOpenAIResponsesRequest(model, textContext(), {
			sessionId: longSessionId,
		});

		expect(request.prompt_cache_key).toBe(Array.from(longSessionId).slice(0, 64).join(""));
		expect(Array.from(request.prompt_cache_key ?? "")).toHaveLength(64);
	});

	it("omits prompt_cache_key when the session id is blank", () => {
		expect(buildOpenAIResponsesRequest(model, textContext(), { sessionId: "   " })).not.toHaveProperty(
			"prompt_cache_key",
		);
	});

	it("preserves tool failure and empty-output semantics as text", () => {
		const context: Context = {
			messages: [
				{
					role: "tool_result",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "permission denied" }],
					isError: true,
					timestamp: 1,
				},
				{
					role: "tool_result",
					toolCallId: "call_2",
					toolName: "write",
					content: [{ type: "text", text: "" }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		expect(buildOpenAIResponsesRequest(model, context).input).toEqual([
			{
				type: "function_call_output",
				call_id: "call_1",
				output: "[tool error]\npermission denied",
			},
			{
				type: "function_call_output",
				call_id: "call_2",
				output: "(no tool output)",
			},
		]);
	});

	it("rejects image input for a text-only model before building a request", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
					timestamp: 1,
				},
			],
		};

		expect(() => buildOpenAIResponsesRequest(model, context)).toThrow(
			"OpenAI model test-openai-model does not support image input",
		);
	});

	it("projects user and tool-result images as data URL input_image blocks", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Inspect this" },
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					role: "tool_result",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "image", data: "AQ==", mimeType: "image/jpeg" }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		expect(buildOpenAIResponsesRequest(imageModel, context).input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Inspect this" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AA==" },
				],
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: [{ type: "input_image", detail: "auto", image_url: "data:image/jpeg;base64,AQ==" }],
			},
		]);
	});

	it("adds reasoning summary configuration only for reasoning models", () => {
		const reasoningModel = { ...model, reasoning: true };
		const request = buildOpenAIResponsesRequest(reasoningModel, textContext());

		expect(request.reasoning).toEqual({ summary: "auto" });
		expect(request.include).toEqual(["reasoning.encrypted_content"]);
		expect(buildOpenAIResponsesRequest(model, textContext()).include).toBeUndefined();
	});

	it("replays same-model reasoning and its paired function call before the tool result", () => {
		const reasoningModel = { ...model, reasoning: true };
		const context: Context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "Inspect the project" }], timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should inspect it." },
						{ type: "tool_call", id: "call_1", name: "bash", arguments: { command: "Get-Location" } },
					],
					provider: "openai",
					model: reasoningModel.id,
					providerReplay: {
						api: "openai-responses",
						data: {
							outputItems: [
								{
									type: "reasoning",
									id: "rs_1",
									summary: [{ type: "summary_text", text: "I should inspect it." }],
									encrypted_content: "encrypted-reasoning",
									status: "completed",
								},
								{
									type: "function_call",
									id: "fc_1",
									call_id: "call_1",
									name: "bash",
									arguments: '{"command":"Get-Location"}',
									status: "completed",
								},
							],
						},
					},
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "tool_use",
					timestamp: 2,
				},
				{
					role: "tool_result",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "D:\\pi\\di-code" }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		expect(buildOpenAIResponsesRequest(reasoningModel, context).input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Inspect the project" }] },
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "I should inspect it." }],
				encrypted_content: "encrypted-reasoning",
				status: "completed",
			},
			{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "bash",
				arguments: '{"command":"Get-Location"}',
				status: "completed",
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: "D:\\pi\\di-code",
			},
		]);
	});

	it("rejects thinking without valid same-model replay metadata", () => {
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "hidden reasoning" }],
					provider: "faux",
					model: "faux-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		};

		expect(() => buildOpenAIResponsesRequest(model, context)).toThrow(
			"OpenAI Responses thinking replay requires provider replay metadata",
		);
	});

	it("rejects replay from another owner or with malformed OpenAI items", () => {
		const replay: ProviderReplay = {
			api: "openai-responses",
			data: {
				outputItems: [
					{
						type: "reasoning",
						id: "rs_valid",
						summary: [],
						encrypted_content: "encrypted",
					},
				],
			},
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "hidden reasoning" }],
			provider: "openai",
			model: model.id,
			providerReplay: replay,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const cases: Array<{ readonly message: AssistantMessage; readonly error: string }> = [
			{
				message: { ...assistant, model: "another-model" },
				error: "OpenAI Responses provider replay requires the same provider and model",
			},
			{
				message: { ...assistant, provider: "another-provider" },
				error: "OpenAI Responses provider replay requires the same provider and model",
			},
			{
				message: { ...assistant, providerReplay: { ...replay, api: "another-api" } },
				error: 'OpenAI Responses provider replay api must be "openai-responses"',
			},
			{
				message: { ...assistant, providerReplay: { ...replay, data: {} } },
				error: "Invalid OpenAI Responses provider replay: data.outputItems must be a non-empty array",
			},
			{
				message: {
					...assistant,
					providerReplay: {
						...replay,
						data: { outputItems: [{ type: "reasoning", id: "rs_empty", summary: [], encrypted_content: "" }] },
					},
				},
				error:
					"Invalid OpenAI Responses provider replay: data.outputItems[0].encrypted_content must be a non-empty string",
			},
		];

		for (const testCase of cases) {
			expect(() => buildOpenAIResponsesRequest(model, { messages: [testCase.message] })).toThrow(testCase.error);
		}
	});

	it("validates model ownership and numeric stream options", () => {
		expect(() => buildOpenAIResponsesRequest({ ...model, provider: "faux" }, textContext())).toThrow(
			'OpenAI Responses requires model.provider to be "openai"',
		);
		expect(() => buildOpenAIResponsesRequest({ ...model, api: "other" }, textContext())).toThrow(
			'OpenAI Responses requires model.api to be "openai-responses"',
		);
		expect(() => buildOpenAIResponsesRequest(model, textContext(), { maxTokens: 0 })).toThrow(
			"maxTokens must be a positive integer",
		);
		expect(() => buildOpenAIResponsesRequest(model, textContext(), { temperature: Number.NaN })).toThrow(
			"temperature must be a finite number between 0 and 2",
		);
	});

	it("does not mutate the source context", () => {
		const context = textContext();
		const snapshot = structuredClone(context);

		buildOpenAIResponsesRequest(model, context);

		expect(context).toEqual(snapshot);
	});
});
