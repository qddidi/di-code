import { describe, expect, it } from "vitest";
import { parseRpcRequest, parseRpcServerMessage, RPC_PROTOCOL_VERSION, RpcProtocolError } from "../src/rpc/protocol.ts";

describe("RPC protocol v1", () => {
	it("accepts versioned prompt, cancel, and state requests", () => {
		expect(
			parseRpcRequest(
				JSON.stringify({
					version: RPC_PROTOCOL_VERSION,
					kind: "request",
					id: "prompt-1",
					method: "prompt",
					params: { message: "hello" },
				}),
			),
		).toMatchObject({ method: "prompt", params: { message: "hello" } });
		expect(
			parseRpcRequest(
				JSON.stringify({
					version: RPC_PROTOCOL_VERSION,
					kind: "request",
					id: "cancel-1",
					method: "cancel",
					params: { requestId: "prompt-1" },
				}),
			),
		).toMatchObject({ method: "cancel", params: { requestId: "prompt-1" } });
		expect(
			parseRpcRequest(
				JSON.stringify({
					version: RPC_PROTOCOL_VERSION,
					kind: "request",
					id: "state-1",
					method: "get_state",
					params: {},
				}),
			),
		).toMatchObject({ method: "get_state" });
	});

	it("rejects malformed JSON, unsupported versions, unknown methods, and invalid params", () => {
		const cases: Array<{ line: string; code: string }> = [
			{ line: "{", code: "PARSE_ERROR" },
			{
				line: JSON.stringify({ version: 2, kind: "request", id: "x", method: "get_state", params: {} }),
				code: "UNSUPPORTED_VERSION",
			},
			{
				line: JSON.stringify({ version: 1, kind: "request", id: "x", method: "delete_all", params: {} }),
				code: "METHOD_NOT_FOUND",
			},
			{
				line: JSON.stringify({ version: 1, kind: "request", id: "x", method: "prompt", params: {} }),
				code: "INVALID_PARAMS",
			},
		];

		for (const testCase of cases) {
			try {
				parseRpcRequest(testCase.line);
				throw new Error("Expected parseRpcRequest to fail");
			} catch (cause) {
				expect(cause).toBeInstanceOf(RpcProtocolError);
				expect((cause as RpcProtocolError).code).toBe(testCase.code);
			}
		}
	});

	it("validates response and event envelopes at the client boundary", () => {
		const response = parseRpcServerMessage(
			JSON.stringify({
				version: 1,
				kind: "response",
				id: "state-1",
				ok: true,
				result: {
					method: "get_state",
					state: { sessionId: "session-1", modelId: "faux-model", isStreaming: false, messageCount: 0 },
				},
			}),
		);
		expect(response.kind).toBe("response");

		const event = parseRpcServerMessage(
			JSON.stringify({
				version: 1,
				kind: "event",
				requestId: "prompt-1",
				event: { type: "agent_start" },
			}),
		);
		expect(event.kind).toBe("event");
	});

	it("rejects unknown error codes, event types, and malformed method results", () => {
		expect(() =>
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "response",
					id: "state-1",
					ok: false,
					error: { code: "MADE_UP", message: "bad" },
				}),
			),
		).toThrow(RpcProtocolError);
		expect(() =>
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "event",
					requestId: "prompt-1",
					event: { type: "future_event" },
				}),
			),
		).toThrow(RpcProtocolError);
		expect(() =>
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "response",
					id: "state-1",
					ok: true,
					result: { method: "get_state" },
				}),
			),
		).toThrow(RpcProtocolError);
		expect(() =>
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "response",
					id: "prompt-1",
					ok: true,
					result: {
						method: "prompt",
						message: {
							role: "assistant",
							content: [],
							provider: "faux",
							model: "faux-model",
							usage: {},
							timestamp: 1,
							stopReason: "future_reason",
						},
					},
				}),
			),
		).toThrow(RpcProtocolError);
	});

	it("validates attachment, operation, and negotiated event payloads", () => {
		expect(
			parseRpcRequest(
				JSON.stringify({
					version: 1,
					kind: "request",
					id: "attachment-1",
					method: "create_attachment",
					params: { name: "diagram.png", contentType: "image/png", data: "aGVsbG8=" },
				}),
			),
		).toMatchObject({ method: "create_attachment" });
		expect(() =>
			parseRpcRequest(
				JSON.stringify({
					version: 1,
					kind: "request",
					id: "attachment-2",
					method: "create_attachment",
					params: { name: "secret.txt", contentType: "text/plain", data: "aGVsbG8=" },
				}),
			),
		).toThrow(RpcProtocolError);

		expect(
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "event",
					requestId: "prompt-1",
					sequence: 3,
					event: {
						type: "operation_update",
						operation: { requestId: "prompt-1", kind: "prompt", status: "running" },
					},
				}),
			),
		).toMatchObject({ kind: "event" });
		expect(() =>
			parseRpcServerMessage(
				JSON.stringify({
					version: 1,
					kind: "response",
					id: "operation-1",
					ok: true,
					result: { method: "get_operation", operation: { requestId: "prompt-1", kind: "prompt", status: "unknown" } },
				}),
			),
		).toThrow(RpcProtocolError);
	});
});
