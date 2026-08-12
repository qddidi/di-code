import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@di-code/agent";
import { type Context, createFauxProvider, type Message, type Provider } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";

function findToolResult(messages: readonly Message[], toolCallId: string) {
	const result = messages.find((message) => message.role === "tool_result" && message.toolCallId === toolCallId);
	if (!result || result.role !== "tool_result") {
		throw new Error(`Missing tool result for ${toolCallId}`);
	}
	return result;
}

describe("AgentSession read integration", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-session-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads a file and sends the tool result to the second provider request", async () => {
		await writeFile(join(root, "notes.txt"), "alpha\nbeta", "utf8");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "read-1",
							name: "read",
							arguments: { path: "notes.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The file contains alpha and beta." }] },
			],
			now: () => 20,
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push([...context.messages]);
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({
			allowedRoot: root,
			provider,
			model: faux.model,
			now: () => 30,
		});
		const events: AgentEvent[] = [];
		const unsubscribe = session.subscribe((event) => {
			events.push(event);
		});

		const assistant = await session.prompt("Read notes.txt");
		unsubscribe();

		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The file contains alpha and beta." }],
		});
		expect(requestedMessages).toHaveLength(2);
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		expect(session.transcript.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"assistant",
		]);
		expect(findToolResult(session.transcript, "read-1")).toMatchObject({
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "alpha\nbeta" }],
		});
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(session.isStreaming).toBe(false);
		expect(faux.pendingResponses()).toBe(0);
	});

	it("returns a read failure to the model and lets the next response recover", async () => {
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "read-missing",
							name: "read",
							arguments: { path: "missing.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The file could not be read." }] },
			],
		});
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
		});

		const assistant = await session.prompt("Read the missing file");

		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The file could not be read." }],
		});
		const result = findToolResult(session.transcript, "read-missing");
		expect(result.isError).toBe(true);
		const content = result.content[0];
		if (!content || content.type !== "text") {
			throw new Error("Expected a text tool error");
		}
		expect(content.text).toContain('Tool "read" failed:');
		expect(content.text).toContain("ENOENT");
		expect(faux.pendingResponses()).toBe(0);
	});
});
