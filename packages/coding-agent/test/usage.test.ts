import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { AgentSession, type AgentSessionEvent } from "./test-agent-session.ts";

describe("AgentSession usage", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-usage-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("tracks requests, context estimates, and usage update events", async () => {
		const manager = await SessionManager.create({ filePath: join(root, "session.jsonl"), cwd: root });
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		const session = new AgentSession({
			allowedRoot: root,
			provider: faux.provider,
			model: faux.model,
			sessionManager: manager,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribeSession((event) => {
			events.push(event);
		});

		await session.prompt("question");

		expect(session.usage.requestCount).toBe(1);
		expect(session.usage.totalTokens).toBe(0);
		expect(session.usage.estimatedContextTokens).toBeGreaterThan(0);
		expect(session.usage.contextWindow).toBe(faux.model.contextWindow);
		expect(events.some((event) => event.type === "usage_update")).toBe(true);
	});
});
