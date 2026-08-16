import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AssistantMessage } from "@di-code/ai";
import { JsonlLineDecoder, serializeJsonLine } from "./jsonl.ts";
import {
	parseRpcServerMessage,
	RPC_PROTOCOL_VERSION,
	type RpcErrorCode,
	type RpcEventRecord,
	type RpcMethod,
	type RpcRequest,
	type RpcSessionState,
	type RpcSuccessResult,
} from "./protocol.ts";

export interface RpcTransport {
	readonly readable: Readable;
	readonly writable: Writable;
	onExit?(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
	close?(): void;
}

interface PendingRequest {
	readonly method: RpcMethod;
	readonly resolve: (result: RpcSuccessResult) => void;
	readonly reject: (error: Error) => void;
}

export class RpcRemoteError extends Error {
	readonly code: RpcErrorCode;

	constructor(code: RpcErrorCode, message: string) {
		super(message);
		this.name = "RpcRemoteError";
		this.code = code;
	}
}

export class RpcClient {
	private readonly transport: RpcTransport;
	private readonly decoder: JsonlLineDecoder;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: RpcEventRecord) => void>();
	private readonly removeExitListener?: () => void;
	private closed = false;

	constructor(transport: RpcTransport) {
		this.transport = transport;
		this.decoder = new JsonlLineDecoder((line) => this.acceptLine(line));
		transport.readable.on("data", this.handleData);
		transport.readable.once("end", this.handleEnd);
		transport.readable.once("error", this.handleError);
		transport.writable.once("error", this.handleError);
		this.removeExitListener = transport.onExit?.((code, signal) => {
			this.fail(new RpcRemoteError("PROCESS_EXIT", `RPC process exited (code=${code} signal=${signal})`));
		});
	}

	subscribe(listener: (event: RpcEventRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getState(): Promise<RpcSessionState> {
		const result = await this.request("get_state", {});
		if (result.method !== "get_state") throw new Error("RPC get_state returned an incompatible result.");
		return result.state;
	}

	async prompt(message: string, options: { readonly signal?: AbortSignal } = {}): Promise<AssistantMessage> {
		const requestId = randomUUID();
		const onAbort = () => {
			void this.cancel(requestId).catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = this.request("prompt", { message }, requestId);
			if (options.signal?.aborted) onAbort();
			const result = await response;
			if (result.method !== "prompt") throw new Error("RPC prompt returned an incompatible result.");
			return result.message;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async cancel(requestId: string): Promise<boolean> {
		const result = await this.request("cancel", { requestId });
		if (result.method !== "cancel") throw new Error("RPC cancel returned an incompatible result.");
		return result.cancelled;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.transport.close?.();
		this.rejectPending(new Error("RPC client is closed."));
	}

	private request(method: "prompt", params: { readonly message: string }, id?: string): Promise<RpcSuccessResult>;
	private request(method: "cancel", params: { readonly requestId: string }, id?: string): Promise<RpcSuccessResult>;
	private request(method: "get_state", params: Record<string, never>, id?: string): Promise<RpcSuccessResult>;
	private request(
		method: RpcMethod,
		params: { readonly message: string } | { readonly requestId: string } | Record<string, never>,
		id = randomUUID(),
	): Promise<RpcSuccessResult> {
		if (this.closed) return Promise.reject(new Error("RPC client is closed."));
		const request = { version: RPC_PROTOCOL_VERSION, kind: "request", id, method, params } as RpcRequest;
		return new Promise<RpcSuccessResult>((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
			this.transport.writable.write(serializeJsonLine(request), (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	private readonly handleData = (chunk: string | Buffer): void => {
		try {
			this.decoder.push(chunk);
		} catch (cause) {
			this.fail(cause instanceof Error ? cause : new Error(String(cause)));
		}
	};

	private readonly handleEnd = (): void => {
		try {
			this.decoder.end();
		} catch (cause) {
			this.fail(cause instanceof Error ? cause : new Error(String(cause)));
			return;
		}
		this.fail(new Error("RPC output ended before the client was closed."));
	};

	private readonly handleError = (error: Error): void => this.fail(error);

	private acceptLine(line: string): void {
		const message = parseRpcServerMessage(line);
		if (message.kind === "event") {
			for (const listener of this.listeners) listener(structuredClone(message));
			return;
		}
		if (!message.ok && message.id === undefined) {
			this.fail(new Error(`${message.error.code}: ${message.error.message}`));
			return;
		}
		if (message.id === undefined) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (!message.ok) {
			pending.reject(new RpcRemoteError(message.error.code, message.error.message));
			return;
		}
		if (message.result.method !== pending.method) {
			pending.reject(new Error(`RPC response method mismatch: expected ${pending.method}.`));
			return;
		}
		pending.resolve(message.result);
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private detach(): void {
		this.transport.readable.off("data", this.handleData);
		this.transport.readable.off("end", this.handleEnd);
		this.transport.readable.off("error", this.handleError);
		this.transport.writable.off("error", this.handleError);
		this.removeExitListener?.();
	}
}
