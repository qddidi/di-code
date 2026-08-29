import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentContext, type AgentEvent, agentLoop } from "@di-code/agent";
import { createFauxProvider, type Message } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { loadSessionFile } from "../src/core/session/session-storage.ts";
import { parseRpcRequest, parseRpcServerMessage, RpcProtocolError } from "../src/rpc/protocol.ts";
import {
	STAGE0_LEGACY_RPC_RECORDS,
	STAGE0_SINGLE_TURN_EVENT_ORDER,
	stage0UnknownSessionRecord,
} from "./fixtures/stage0-protocol-fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function userMessage(text: string): Extract<Message, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("plugin runtime stage 0 protocol baseline", () => {
	it("freezes the single-turn Agent event order", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }],
			chunkSize: 100,
		});
		const context: AgentContext = { systemPrompt: "baseline", messages: [] };
		const stream = agentLoop(userMessage("hello"), context, { provider: faux.provider, model: faux.model });
		const events = await collect(stream);

		expect(events.map((event) => event.type)).toEqual(STAGE0_SINGLE_TURN_EVENT_ORDER);
		expect((await stream.result()).at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("serializes concurrent SessionManager appends in submission order", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-stage0-session-"));
		roots.push(root);
		const manager = await SessionManager.create({
			filePath: join(root, "session.jsonl"),
			cwd: root,
			createId: (() => {
				const ids = ["session-1", "entry-1", "entry-2"];
				return () => {
					const id = ids.shift();
					if (!id) throw new Error("fixture ID sequence exhausted");
					return id;
				};
			})(),
		});

		await Promise.all([manager.appendMessage(userMessage("first")), manager.appendMessage(userMessage("second"))]);
		expect(manager.entries.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
			{ id: "entry-1", parentId: "session-1" },
			{ id: "entry-2", parentId: "entry-1" },
		]);
	});

	it("diagnoses and stops at an unknown Session record instead of silently accepting a suffix", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-stage0-diagnostic-"));
		roots.push(root);
		const filePath = join(root, "session.jsonl");
		const header = {
			type: "session",
			version: 2,
			id: "session-1",
			parentId: null,
			timestamp: "2026-08-28T00:00:00.000Z",
			cwd: root,
		};
		const suffix = {
			type: "message",
			version: 2,
			id: "entry-1",
			parentId: "future-1",
			timestamp: "2026-08-28T00:00:00.000Z",
			message: userMessage("untrusted suffix"),
		};
		await writeFile(
			filePath,
			`${JSON.stringify(header)}\n${JSON.stringify(stage0UnknownSessionRecord())}\n${JSON.stringify(suffix)}\n`,
		);

		const loaded = await loadSessionFile(filePath);
		expect(loaded.entries).toEqual([]);
		expect(loaded.diagnostics).toEqual([
			{ kind: "corrupt_record", lineNumber: 2, reason: 'record type must be "message", "summary", or "plugin"' },
		]);
	});

	it("keeps the v1 RPC envelope consumable by legacy clients", () => {
		for (const record of STAGE0_LEGACY_RPC_RECORDS) {
			expect(parseRpcServerMessage(JSON.stringify(record))).toMatchObject({ version: 1, kind: record.kind });
		}
		expect(
			parseRpcRequest(JSON.stringify({ version: 1, kind: "request", id: "state-1", method: "get_state", params: {} })),
		).toMatchObject({ method: "get_state" });
		expect(() =>
			parseRpcRequest(JSON.stringify({ version: 2, kind: "request", id: "state-1", method: "get_state", params: {} })),
		).toThrow(RpcProtocolError);
	});
});
