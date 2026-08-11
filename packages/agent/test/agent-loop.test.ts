import { createFauxProvider } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import type { AgentContext, AgentEvent, AgentMessage } from "../src/index.ts";
import { agentLoop } from "../src/index.ts";

function userMessage(text: string, timestamp = 10): Extract<AgentMessage, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function context(messages: AgentMessage[] = []): AgentContext {
	return { systemPrompt: "You are concise.", messages };
}

describe("agent loop contracts", () => {
	it("accepts context and preview-shaped lifecycle events", () => {
		const contextValue: AgentContext = { messages: [] };
		const event: AgentEvent = { type: "agent_start" };
		expect(contextValue.messages).toEqual([]);
		expect(event.type).toBe("agent_start");
	});
	it("calls provider once and emits stable text lifecycle", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "hello" }] }],
			chunkSize: 2,
			now: () => 20,
		});
		const stream = agentLoop(userMessage("say hello"), context(), {
			provider: faux.provider,
			model: faux.model,
		});
		const events = await collect(stream);
		const messages = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[1]).toMatchObject({
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		});
		expect(faux.pendingResponses()).toBe(0);
	});

	it("settles with a failed assistant message for a model error", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "failure", errorMessage: "model failed" }],
			now: () => 30,
		});
		const stream = agentLoop(userMessage("fail"), context(), {
			provider: faux.provider,
			model: faux.model,
		});
		const events = await collect(stream);
		const messages = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "model failed",
		});
	});

	it("settles after cancellation at the first text delta", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "abcdef" }] }],
			chunkSize: 2,
			now: () => 40,
		});
		const stream = agentLoop(
			userMessage("cancel"),
			context(),
			{ provider: faux.provider, model: faux.model },
			controller.signal,
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "message_update" && event.event.type === "text_delta") {
				controller.abort("test cancellation");
			}
		}
		const messages = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(messages.at(-1)).toMatchObject({
			stopReason: "aborted",
			content: [{ type: "text", text: "ab" }],
		});
	});

	it("normalizes a provider throw into a settled error turn", async () => {
		const model = {
			id: "broken-model",
			name: "Broken",
			provider: "broken",
			api: "broken",
			input: ["text" as const],
			reasoning: false,
			contextWindow: 100,
			maxOutputTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const provider = {
			id: "broken",
			name: "Broken",
			models: [model],
			stream() {
				throw new Error("transport broke");
			},
		};
		const stream = agentLoop(userMessage("throw"), context(), { provider, model });
		const events = await collect(stream);
		const messages = await stream.result();

		expect(events.at(-1)?.type).toBe("agent_end");
		expect(messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "transport broke",
		});
	});
});
