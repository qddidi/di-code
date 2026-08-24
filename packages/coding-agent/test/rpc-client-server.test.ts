import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AssistantMessage } from "@di-code/ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionListener } from "../src/core/session.ts";
import { RpcClient, type RpcRemoteError, type RpcTransport } from "../src/rpc/client.ts";
import { disposeRpcComposition } from "../src/rpc/lifecycle.ts";
import { RpcServer, type RpcSession } from "../src/rpc/server.ts";

function assistant(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
	if (stopReason === "aborted") {
		return {
			role: "assistant",
			content: [],
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
			stopReason: "aborted",
			errorMessage: "Request aborted",
		};
	}
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

class FakeSession implements RpcSession {
	readonly sessionId = "session-1";
	readonly modelId = "faux-model";
	readonly transcript: AssistantMessage[] = [];
	isStreaming = false;
	signalAborted = false;
	private readonly listeners = new Set<AgentSessionListener>();
	private releasePrompt?: () => void;
	private resolveStreaming?: () => void;
	private readonly streamingStarted = new Promise<void>((resolve) => {
		this.resolveStreaming = resolve;
	});

	subscribeSession(listener: AgentSessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage> {
		if (this.isStreaming) throw new Error("AgentSession is already processing a prompt.");
		this.isStreaming = true;
		this.resolveStreaming?.();
		const completion = new Promise<void>((resolve) => {
			this.releasePrompt = resolve;
			if (signal?.aborted) {
				this.signalAborted = true;
				resolve();
			} else {
				signal?.addEventListener(
					"abort",
					() => {
						this.signalAborted = true;
						resolve();
					},
					{ once: true },
				);
			}
		});
		await this.emit({ type: "agent_start" });
		await completion;
		const result = signal?.aborted ? assistant("", "aborted") : assistant(text.toUpperCase());
		this.transcript.push(result);
		this.isStreaming = false;
		await this.emit({ type: "agent_end", messages: [result] });
		return result;
	}

	finishPrompt(): void {
		this.releasePrompt?.();
	}

	waitForStreaming(): Promise<void> {
		return this.streamingStarted;
	}

	private async emit(event: AgentSessionEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}
}

function createConnectedPair(session = new FakeSession()) {
	const clientToServer = new PassThrough();
	const serverToClient = new PassThrough();
	const server = new RpcServer({ session, input: clientToServer, output: serverToClient });
	server.start();
	const client = new RpcClient({ readable: serverToClient, writable: clientToServer });
	return { client, server, session };
}

describe("RPC client/server", () => {
	it("correlates prompt events and the final response", async () => {
		const { client, server, session } = createConnectedPair();
		const eventTypes: string[] = [];
		client.subscribe((record) => eventTypes.push(record.event.type));

		const response = client.prompt("hello");
		await session.waitForStreaming();
		await expect(client.getState()).resolves.toMatchObject({ isStreaming: true, messageCount: 0 });
		session.finishPrompt();

		await expect(response).resolves.toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "HELLO" }],
		});
		expect(eventTypes).toEqual(["agent_start", "agent_end"]);
		client.close();
		server.stop();
	});

	it("rejects a concurrent prompt with BUSY without disturbing the active prompt", async () => {
		const { client, server, session } = createConnectedPair();
		const first = client.prompt("first");

		await expect(client.prompt("second")).rejects.toMatchObject({ code: "BUSY" } satisfies Partial<RpcRemoteError>);
		session.finishPrompt();
		await expect(first).resolves.toMatchObject({ stopReason: "stop" });
		client.close();
		server.stop();
	});

	it("propagates AbortSignal cancellation to the active prompt", async () => {
		const { client, server } = createConnectedPair();
		const controller = new AbortController();
		const prompt = client.prompt("cancel me", { signal: controller.signal });

		controller.abort();

		await expect(prompt).resolves.toMatchObject({ stopReason: "aborted" });
		client.close();
		server.stop();
	});

	it("propagates a signal that was aborted before prompt was called", async () => {
		const { client, server, session } = createConnectedPair();
		const controller = new AbortController();
		controller.abort();

		const prompt = client.prompt("already cancelled", { signal: controller.signal });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const observedAbort = session.signalAborted;
		session.finishPrompt();
		const message = await prompt;

		expect(observedAbort).toBe(true);
		expect(message.stopReason).toBe("aborted");
		client.close();
		server.stop();
	});

	it("serializes racing shutdown calls after returning the cancelled prompt response", async () => {
		const { client, server, session } = createConnectedPair();
		const prompt = client.prompt("shutdown");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const first = server.shutdown();
		const second = server.shutdown();

		expect(second).toBe(first);
		await expect(prompt).resolves.toMatchObject({ stopReason: "aborted" });
		await first;
		await expect(server.finished()).resolves.toBeUndefined();
		expect(session.signalAborted).toBe(true);
		client.close();
	});

	it("reports a flush failure only after it has finished request shutdown", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(chunk, _encoding, callback) {
				callback(chunk.length === 0 ? new Error("flush failed") : undefined);
			},
		});
		output.on("error", () => undefined);
		const server = new RpcServer({ session: new FakeSession(), input, output });
		server.start();

		await expect(server.shutdown()).rejects.toThrow("flush failed");
		await expect(server.finished()).resolves.toBeUndefined();
	});
});

describe("RPC composition disposal", () => {
	it("disposes the context after a loader disposal failure", async () => {
		const calls: string[] = [];
		await expect(
			disposeRpcComposition(
				() => {
					calls.push("loader");
					throw new Error("loader dispose failed");
				},
				() => {
					calls.push("context");
				},
			),
		).rejects.toThrow("loader dispose failed");
		expect(calls).toEqual(["loader", "context"]);
	});

	it("surfaces both failures after attempting every composition disposer", async () => {
		const calls: string[] = [];
		await expect(
			disposeRpcComposition(
				() => {
					calls.push("loader");
					throw new Error("loader dispose failed");
				},
				() => {
					calls.push("context");
					throw new Error("context dispose failed");
				},
			),
		).rejects.toThrow(AggregateError);
		expect(calls).toEqual(["loader", "context"]);
	});
});

describe("RpcClient process lifecycle", () => {
	it("rejects every pending request when the child process exits", async () => {
		const readable = new PassThrough();
		const writable = new PassThrough();
		const exits = new EventEmitter();
		const transport: RpcTransport = {
			readable,
			writable,
			onExit(listener) {
				exits.on("exit", listener);
				return () => exits.off("exit", listener);
			},
		};
		const client = new RpcClient(transport);
		const pending = client.getState();

		exits.emit("exit", 43, null);

		await expect(pending).rejects.toThrow("RPC process exited (code=43 signal=null)");
		client.close();
	});
});
