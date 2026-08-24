import type { AssistantMessage } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionListener } from "../src/core/session.ts";
import { RpcDispatcher, type RpcSession } from "../src/rpc/dispatcher.ts";
import { RPC_PROTOCOL_VERSION, type RpcRequest, type RpcServerMessage } from "../src/rpc/protocol.ts";

function request(id: string, method: RpcRequest["method"], params: Record<string, unknown> = {}): RpcRequest {
	return { version: RPC_PROTOCOL_VERSION, kind: "request", id, method, params };
}

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp: 1,
		stopReason: "stop",
	};
}

class DeferredSession implements RpcSession {
	readonly sessionId = "session-1";
	readonly modelId = "faux-model";
	readonly transcript: AssistantMessage[] = [];
	isStreaming = false;
	private readonly listeners = new Set<AgentSessionListener>();
	private finish?: () => void;
	subscribeSession(listener: AgentSessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		this.isStreaming = true;
		await this.emit({ type: "agent_start" });
		await new Promise<void>((resolve) => {
			this.finish = resolve;
			signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		this.isStreaming = false;
		const result = message(text);
		this.transcript.push(result);
		await this.emit({ type: "agent_end", messages: [result] });
		return result;
	}
	release(): void {
		this.finish?.();
	}
	private async emit(event: AgentSessionEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}
}

describe("RpcDispatcher", () => {
	it("keeps duplicate request IDs idempotent and exposes their detached operation", async () => {
		const session = new DeferredSession();
		const dispatcher = new RpcDispatcher({ session });
		const first = dispatcher.dispatch(request("prompt-1", "prompt", { message: "hello" }));
		const duplicate = dispatcher.dispatch(request("prompt-1", "prompt", { message: "different" }));
		const operation = await dispatcher.dispatch(request("operation-1", "get_operation", { requestId: "prompt-1" }));
		expect(operation).toMatchObject({
			ok: true,
			result: { method: "get_operation", operation: { status: "running" } },
		});
		session.release();
		expect(await duplicate).toEqual(await first);
		await dispatcher.dispose();
	});

	it("cancels detached operations and never emits extended events before negotiation", async () => {
		const session = new DeferredSession();
		const dispatcher = new RpcDispatcher({ session });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		const prompt = dispatcher.dispatch(request("prompt-1", "prompt", { message: "hello" }));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await dispatcher.dispatch(request("cancel-1", "cancel", { requestId: "prompt-1" }));
		await expect(prompt).resolves.toMatchObject({ ok: true, result: { method: "prompt" } });
		expect(records.every((record) => record.kind !== "event" || record.event.type !== "operation_update")).toBe(true);
		await dispatcher.dispose();
	});

	it("uses a bounded sequence buffer and asks negotiated clients for a snapshot after overflow", async () => {
		const session = new DeferredSession();
		const dispatcher = new RpcDispatcher({ session, eventBufferSize: 1 });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		await dispatcher.dispatch(
			request("hello", "get_capabilities", { events: ["sequence", "operation_update", "snapshot_required"] }),
		);
		const prompt = dispatcher.dispatch(request("prompt-1", "prompt", { message: "hello" }));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		session.release();
		await prompt;
		const replay = await dispatcher.dispatch(request("resume", "resume_events", { lastSequence: 0 }));
		expect(replay).toMatchObject({ ok: true, result: { snapshotRequired: true } });
		expect(records.some((record) => record.kind === "event" && record.event.type === "snapshot_required")).toBe(true);
		await dispatcher.dispose();
	});

	it("keeps uploaded attachments in memory and consumes them with the named operation", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		const uploaded = await dispatcher.dispatch(
			request("attachment-1", "create_attachment", {
				name: "diagram.png",
				contentType: "image/png",
				data: "aGVsbG8=",
			}),
		);
		expect(uploaded).toMatchObject({
			ok: true,
			result: { method: "create_attachment", attachment: { name: "diagram.png", bytes: 5 } },
		});
		const attachmentId = (uploaded as Extract<typeof uploaded, { readonly ok: true }>).result.attachment as {
			id: string;
		};
		const prompt = await dispatcher.dispatch(
			request("prompt-1", "prompt", { message: "describe", attachmentIds: [attachmentId.id] }),
		);
		expect(prompt).toMatchObject({ ok: false, error: { code: "METHOD_NOT_FOUND" } });
		const reused = await dispatcher.dispatch(
			request("prompt-2", "prompt", { message: "describe", attachmentIds: [attachmentId.id] }),
		);
		expect(reused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		await dispatcher.dispose();
	});

	it("projects ProductHost trust as an immutable composition snapshot", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession(), productState: { projectTrusted: true } });
		await expect(dispatcher.dispatch(request("product-1", "get_product_state"))).resolves.toMatchObject({
			ok: true,
			result: { method: "get_product_state", state: { projectTrusted: true } },
		});
		await expect(dispatcher.dispatch(request("trust-1", "get_project_trust"))).resolves.toMatchObject({
			ok: true,
			result: { method: "get_project_trust", trusted: true },
		});
		await dispatcher.dispose();
	});
});
