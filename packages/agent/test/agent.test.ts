import { createFauxProvider, type Message } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";

describe("Agent state wrapper", () => {
	it("commits transcript only when agent_end arrives", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "hello" }] }],
			now: () => 100,
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model, systemPrompt: "Be brief.", now: () => 10 });
		const snapshots: number[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_update") snapshots.push(agent.state.messages.length);
		});

		expect(agent.state).toEqual({ messages: [], isStreaming: false });
		const assistant = await agent.prompt("say hello");

		expect(assistant).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(snapshots.length).toBeGreaterThan(0);
		expect(snapshots.every((length) => length === 0)).toBe(true);
		expect(agent.transcript.map((message) => message.role)).toEqual(["user", "assistant"]);
		const snapshot = agent.state.messages;
		(snapshot as Message[]).push({ role: "user", content: [{ type: "text", text: "outside" }], timestamp: 999 });
		expect(agent.transcript).toHaveLength(2);
		expect(agent.isStreaming).toBe(false);
	});

	it("returns a failed assistant and clears streaming after a model error", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "failure", errorMessage: "model failed" }],
			now: () => 200,
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });

		const assistant = await agent.prompt("fail");

		expect(assistant).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "model failed" });
		expect(agent.state.messages.at(-1)).toBe(assistant);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("settles an aborted prompt and clears streaming", async () => {
		const controller = new AbortController();
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "abcdef" }] }],
			chunkSize: 2,
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		agent.subscribe((event) => {
			if (event.type === "message_update" && event.event.type === "text_delta") controller.abort("test cancellation");
		});

		const assistant = await agent.prompt("cancel", controller.signal);

		expect(assistant.stopReason).toBe("aborted");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("awaits listeners in registration order", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "ok" }] },
				{ type: "success", content: [{ type: "text", text: "again" }] },
			],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		const order: string[] = [];
		agent.subscribe(async (event) => {
			if (event.type === "agent_start") {
				order.push("first:start");
				await Promise.resolve();
				order.push("first:end");
			}
		});
		let secondCalls = 0;
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "agent_start") {
				secondCalls++;
				order.push("second");
			}
		});

		await agent.prompt("order");

		expect(order).toEqual(["first:start", "first:end", "second"]);
		expect(secondCalls).toBe(1);
		unsubscribe();
		await agent.prompt("again");
		expect(secondCalls).toBe(1);
	});

	it("rejects listener failure but always clears streaming", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		agent.subscribe((event) => {
			if (event.type === "message_update") throw new Error("listener failed");
		});

		await expect(agent.prompt("listener")).rejects.toThrow("listener failed");
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.transcript).toHaveLength(2);
	});

	it("rejects a second prompt while the first is active", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "first" }] },
				{ type: "success", content: [{ type: "text", text: "second" }] },
			],
		});
		const agent = new Agent({ provider: faux.provider, model: faux.model });
		const first = agent.prompt("first");

		expect(agent.isStreaming).toBe(true);
		await expect(agent.prompt("second")).rejects.toThrow("Agent is already processing a prompt.");
		await first;
		expect(faux.pendingResponses()).toBe(1);
	});
});
