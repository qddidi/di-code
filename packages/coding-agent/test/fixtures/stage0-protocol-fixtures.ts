import type { AgentEvent } from "@di-code/agent";
import type { RpcServerMessage } from "../../src/rpc/protocol.ts";

/** The single-turn lifecycle order frozen for later Agent hook stages. */
export const STAGE0_SINGLE_TURN_EVENT_ORDER = [
	"agent_start",
	"turn_start",
	"message_start",
	"message_end",
	"message_start",
	"message_update",
	"message_update",
	"message_update",
	"message_end",
	"turn_end",
	"agent_end",
] as const satisfies readonly AgentEvent["type"][];

/** v1 records that a client predating extension negotiation can still consume. */
export const STAGE0_LEGACY_RPC_RECORDS = [
	{
		version: 1,
		kind: "response",
		id: "state-1",
		ok: true,
		result: {
			method: "get_state",
			state: { sessionId: "session-1", modelId: "faux-model", isStreaming: false, messageCount: 0 },
		},
	},
	{
		version: 1,
		kind: "event",
		requestId: "prompt-1",
		event: { type: "agent_start" },
	},
] as const satisfies readonly RpcServerMessage[];

export function stage0UnknownSessionRecord(parentId = "session-1"): Record<string, unknown> {
	return {
		type: "future_record",
		version: 2,
		id: "future-1",
		parentId,
		timestamp: "2026-08-28T00:00:00.000Z",
		payload: { retained: true },
	};
}
