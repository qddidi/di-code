import { describe, expect, it } from "vitest";
import { parseRpcServerMessage, RPC_PROTOCOL_VERSION } from "../src/rpc/protocol.ts";

describe("stage 7 RPC compatibility", () => {
	it("parses typed projection events only as versioned event records", () => {
		const message = parseRpcServerMessage(
			JSON.stringify({
				version: RPC_PROTOCOL_VERSION,
				kind: "event",
				requestId: "projection-1",
				event: {
					type: "projection",
					namespace: "plan",
					projectionName: "state",
					version: 1,
					state: { status: "active" },
				},
			}),
		);
		expect(message).toMatchObject({ kind: "event", event: { type: "projection", namespace: "plan" } });
	});

	it("does not treat an untyped extension event as a valid legacy event", () => {
		expect(() =>
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "event",
					requestId: "legacy",
					event: { type: "extension_state", value: {} },
				}),
			),
		).toThrow("typed event");
	});
});
