import type { AssistantMessage } from "@di-code/ai";
import { createCommandRegistry } from "@di-code/builtins";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionListener } from "../src/core/session.ts";
import { RpcDispatcher, type RpcSession } from "../src/rpc/dispatcher.ts";
import { parseRpcRequest, RPC_PROTOCOL_VERSION, type RpcRequest, type RpcServerMessage } from "../src/rpc/protocol.ts";
import type { ProductHost } from "../src/runtime/product-host.ts";
import type { SessionHost } from "../src/runtime/session-host.ts";

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
	private resolveStarted?: () => void;
	private readonly started = new Promise<void>((resolve) => {
		this.resolveStarted = resolve;
	});
	subscribeSession(listener: AgentSessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		this.isStreaming = true;
		await this.emit({ type: "agent_start" });
		await new Promise<void>((resolve) => {
			this.finish = resolve;
			this.resolveStarted?.();
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
	async waitForPrompt(): Promise<void> {
		await this.started;
	}
	private async emit(event: AgentSessionEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}
}

describe("RpcDispatcher", () => {
	it("exposes plan command and projection for SessionHost clients", async () => {
		let received = "";
		let projection = { active: false, pending: false };
		const host = {
			planMode: () => projection,
			planCommand: async (args: string) => {
				received = args;
				projection = { active: args !== "off", pending: false };
				return projection.active ? "Plan mode enabled." : "Plan mode disabled.";
			},
			state: () => ({
				disposed: false,
				workspace: ".",
				busy: false,
				operations: [],
				activeSession: { id: "s", cwd: ".", label: "s" },
			}),
			ui: () => ({ availableSkills: [] }),
			subscribe: () => () => undefined,
		} as unknown as SessionHost;
		const dispatcher = new RpcDispatcher({ session: host });
		const capabilities = await dispatcher.dispatch(
			request("capabilities", "get_capabilities", { events: ["projection"] }),
		);
		expect(capabilities).toMatchObject({ ok: true });
		const listed = await dispatcher.dispatch(request("list", "list_commands"));
		expect(listed).toMatchObject({ ok: true });
		const listedCommands = (
			listed as unknown as { readonly result: { readonly commands: readonly { readonly name: string }[] } }
		).result.commands;
		expect(listedCommands.some((command) => command.name === "plan")).toBe(true);
		const executed = await dispatcher.dispatch(request("run", "run_command", { name: "plan", args: "off" }));
		expect(executed).toMatchObject({ ok: true, result: { command: "plan" } });
		expect(received).toBe("off");
		await dispatcher.dispose();
	});

	it("lists and executes composition-registered commands", async () => {
		const commands = createCommandRegistry();
		let receivedArgs: string | undefined;
		commands.register({
			name: "custom-check",
			description: "Run the custom check",
			run: (input) => {
				receivedArgs = (input as { readonly args?: string }).args;
				return 0;
			},
		});
		const dispatcher = new RpcDispatcher({ session: new DeferredSession(), commandRegistry: commands });
		const listed = await dispatcher.dispatch(request("list-commands", "list_commands"));
		expect(listed).toMatchObject({
			ok: true,
			result: { method: "list_commands", commands: [{ name: "custom-check", description: "Run the custom check" }] },
		});
		const executed = await dispatcher.dispatch(
			request("run-command", "run_command", { name: "custom-check", args: "verify" }),
		);
		expect(executed).toMatchObject({ ok: true, result: { method: "run_command", command: "custom-check" } });
		expect(receivedArgs).toBe("verify");
		await dispatcher.dispose();
	});

	it("correlates a tool approval event with the approving RPC request", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		await dispatcher.dispatch(request("capabilities", "get_capabilities", { events: ["tool_approval"] }));
		const pending = dispatcher.requestToolApproval("write", { path: ".di-code/check.txt" });
		const event = records.find((record) => record.kind === "event" && record.event.type === "tool_approval");
		expect(event).toMatchObject({
			kind: "event",
			event: { toolName: "write", arguments: { path: ".di-code/check.txt" } },
		});
		if (!event || event.kind !== "event") throw new Error("Expected a tool approval event.");
		const approvalId = (event.event as unknown as { readonly approvalId: string }).approvalId;
		await dispatcher.dispatch(request("approve", "approve_tool", { approvalId, approved: true }));
		await expect(pending).resolves.toBe(true);
		await dispatcher.dispose();
	});

	it("routes structured interactions and makes duplicate responses idempotent", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		await dispatcher.dispatch(request("capabilities", "get_capabilities", { events: ["interaction_request"] }));
		const pending = dispatcher.requestInteraction({
			requestId: "interaction-1",
			kind: "question",
			prompt: "Continue?",
			intent: "plan-review",
		});
		const event = records.find((record) => record.kind === "event" && record.event.type === "interaction_request");
		expect(event).toMatchObject({ event: { interactionRequestId: "interaction-1", prompt: "Continue?" } });
		await dispatcher.dispatch(
			request("answer-1", "respond_interaction", { requestId: "interaction-1", status: "answered", value: "continue" }),
		);
		await dispatcher.dispatch(
			request("answer-2", "respond_interaction", { requestId: "interaction-1", status: "answered", value: "cancel" }),
		);
		await expect(pending).resolves.toMatchObject({ status: "answered", value: "continue" });
		await dispatcher.dispose();
	});

	it("fails interaction fast without a negotiated UI channel and denies approval by default", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		await expect(dispatcher.requestInteraction({ kind: "question", prompt: "No UI" })).rejects.toMatchObject({
			code: "INTERACTION_UNAVAILABLE",
		});
		await expect(dispatcher.requestToolApproval("write", { path: "x" })).resolves.toBe(false);
		await dispatcher.dispose();
	});

	it("does not publish projections containing local paths or credentials", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		await dispatcher.dispatch(request("capabilities", "get_capabilities", { events: ["projection"] }));
		dispatcher.emitProjection({ namespace: "plan", projectionName: "state", version: 1, state: { cwd: "C:/private" } });
		dispatcher.emitProjection({ namespace: "plan", projectionName: "state", version: 1, state: { status: "active" } });
		expect(records.filter((record) => record.kind === "event" && record.event.type === "projection")).toHaveLength(1);
		await dispatcher.dispose();
	});

	it("replays negotiated projection and interaction events after disconnect", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		await dispatcher.dispatch(
			request("capabilities", "get_capabilities", { events: ["sequence", "projection", "interaction_request"] }),
		);
		dispatcher.emitProjection({ namespace: "plan", projectionName: "mode", version: 1, state: { active: true } });
		const pending = dispatcher.requestInteraction({
			requestId: "resume-interaction",
			kind: "question",
			prompt: "Continue?",
		});
		const last = Math.max(...records.filter((record) => record.kind === "event").map((record) => record.sequence ?? 0));
		const before = records.length;
		await dispatcher.dispatch(request("resume", "resume_events", { lastSequence: last - 2 }));
		expect(records.length).toBeGreaterThan(before);
		expect(records.slice(before).some((record) => record.kind === "event" && record.event.type === "projection")).toBe(
			true,
		);
		await dispatcher.dispatch(
			request("answer", "respond_interaction", { requestId: "resume-interaction", status: "cancelled" }),
		);
		await pending;
		await dispatcher.dispose();
	});

	it("completes pending interaction on timeout and dispatcher unload", async () => {
		const dispatcher = new RpcDispatcher({ session: new DeferredSession() });
		await dispatcher.dispatch(request("capabilities", "get_capabilities", { events: ["interaction_request"] }));
		await expect(
			dispatcher.requestInteraction({ requestId: "timeout", kind: "question", prompt: "Wait", timeoutMs: 1 }),
		).resolves.toMatchObject({ status: "timeout" });
		const pending = dispatcher.requestInteraction({ requestId: "dispose", kind: "question", prompt: "Close" });
		await dispatcher.dispose();
		await expect(pending).resolves.toMatchObject({ status: "disposed" });
	});

	it("tracks cancellable ProductHost changes and forwards redacted audit events", async () => {
		const session = new DeferredSession();
		const listeners = new Set<
			(event: { readonly type: "product_audit"; readonly action: "set_project_trust" }) => void
		>();
		let resolveStarted: (() => void) | undefined;
		const didStart = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const product = {
			state: () => ({ projectTrusted: false }),
			listProviders: () => [],
			login: async () => ({ id: "faux", name: "Faux", models: [], configured: true }),
			logout: async () => undefined,
			getProjectTrust: () => false,
			setProjectTrust: async (_trusted: boolean, signal?: AbortSignal) => {
				resolveStarted?.();
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
				});
				return true;
			},
			listContextFiles: async () => [],
			listMcpServers: async () => [],
			configureMcpServer: async () => ({ id: "server", state: "disconnected", tools: 0, resources: 0, prompts: 0 }),
			removeMcpServer: async () => undefined,
			reconnectMcpServer: async () => ({ id: "server", state: "disconnected", tools: 0, resources: 0, prompts: 0 }),
			subscribe: (
				listener: (event: { readonly type: "product_audit"; readonly action: "set_project_trust" }) => void,
			) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose: async () => undefined,
		} as unknown as ProductHost;
		const dispatcher = new RpcDispatcher({ session, productHost: product });
		const records: RpcServerMessage[] = [];
		dispatcher.subscribe((record) => records.push(record));
		await dispatcher.dispatch(request("capabilities", "get_capabilities", { events: ["product_audit"] }));
		const operation = dispatcher.dispatch(request("trust", "set_project_trust", { trusted: true }));
		await didStart;
		await dispatcher.dispatch(request("cancel-trust", "cancel", { requestId: "trust" }));
		await expect(operation).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
		listeners.forEach((listener) => {
			listener({ type: "product_audit", action: "set_project_trust" });
		});
		expect(records.some((record) => record.kind === "event" && record.event.type === "product_audit")).toBe(true);
		await dispatcher.dispose();
	});

	it("returns a redacted cause when a ProductHost operation fails", async () => {
		const product = {
			login: async () => {
				throw new Error("Unable to save apiKey=top-secret-value");
			},
			subscribe: () => () => undefined,
		} as unknown as ProductHost;
		const dispatcher = new RpcDispatcher({ session: new DeferredSession(), productHost: product });
		const response = await dispatcher.dispatch(
			request("failed-login", "login", { providerId: "zhipu", apiKey: "top-secret-value", modelId: "glm-5.3" }),
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "INTERNAL_ERROR", message: "Unable to save apiKey=[REDACTED]" },
		});
		await dispatcher.dispose();
	});
	it("keeps duplicate request IDs idempotent and exposes their detached operation", async () => {
		const session = new DeferredSession();
		const dispatcher = new RpcDispatcher({ session });
		const first = dispatcher.dispatch(request("prompt-1", "prompt", { message: "hello" }));
		await session.waitForPrompt();
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
		await session.waitForPrompt();
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
		await session.waitForPrompt();
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

	it("expires retained terminal operations instead of retaining detached state indefinitely", async () => {
		const session = new DeferredSession();
		const dispatcher = new RpcDispatcher({ session, operationTtlMs: 1 });
		const prompt = dispatcher.dispatch(request("prompt-1", "prompt", { message: "hello" }));
		await session.waitForPrompt();
		session.release();
		await prompt;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		await expect(
			dispatcher.dispatch(request("operation-1", "get_operation", { requestId: "prompt-1" })),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
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

	it("rejects invalid explicit thinking levels before dispatch", async () => {
		expect(() =>
			parseRpcRequest(
				JSON.stringify({
					version: 1,
					kind: "request",
					id: "thinking",
					method: "set_thinking_level",
					params: { level: "unsupported" },
				}),
			),
		).toThrow("set_thinking_level.level must be a valid thinking level.");
	});
});
