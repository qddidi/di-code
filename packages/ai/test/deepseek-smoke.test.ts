import { describe, expect, it } from "vitest";
import type { Context, Model, ToolDefinition } from "../src/index.ts";
import { createDeepSeekProvider, Type } from "../src/index.ts";

const enabled =
	process.env.DI_CODE_DEEPSEEK_SMOKE === "1" &&
	typeof process.env.DEEPSEEK_API_KEY === "string" &&
	process.env.DEEPSEEK_API_KEY.trim().length > 0 &&
	typeof process.env.DEEPSEEK_MODEL === "string" &&
	process.env.DEEPSEEK_MODEL.trim().length > 0;

const describeSmoke = enabled ? describe : describe.skip;

function smokeModel(): Model {
	return {
		id: process.env.DEEPSEEK_MODEL?.trim() ?? "",
		name: "Configured DeepSeek smoke model",
		provider: "deepseek",
		api: "deepseek-responses",
		baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
		input: ["text"],
		reasoning: true,
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describeSmoke("DeepSeek Responses real smoke", () => {
	it("returns non-empty text", async () => {
		const provider = createDeepSeekProvider({ models: [smokeModel()] });
		const context: Context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "Reply with exactly: smoke ok" }], timestamp: Date.now() },
			],
		};
		const result = await provider.stream(smokeModel(), context).result();
		if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Unexpected stop: ${result.stopReason}`);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		expect(text.trim().length).toBeGreaterThan(0);
	});

	it("completes one tool call and a follow-up answer", async () => {
		const tool: ToolDefinition = {
			name: "smoke_echo",
			description: "Return the supplied text unchanged.",
			parameters: Type.Object({ text: Type.String() }),
		};
		const provider = createDeepSeekProvider({ models: [smokeModel()] });
		const firstContext: Context = {
			tools: [tool],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Call smoke_echo with text hello." }], timestamp: Date.now() },
			],
		};
		const first = await provider.stream(smokeModel(), firstContext).result();
		const call = first.content.find((block) => block.type === "tool_call");
		if (!call || call.type !== "tool_call") throw new Error("Smoke model did not request smoke_echo");
		const secondContext: Context = {
			...firstContext,
			messages: [
				...firstContext.messages,
				first,
				{
					role: "tool_result",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "hello" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		const second = await provider.stream(smokeModel(), secondContext).result();
		expect(second.stopReason).toBe("stop");
	});
});
