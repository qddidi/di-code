import type { Readable, Writable } from "node:stream";
import type { UserInteractionInput, UserInteractionResult } from "@di-code/plugin-sdk";
import { RpcDispatcher, type RpcDispatcherOptions, type RpcSession } from "./dispatcher.ts";
import { JsonlLineDecoder, serializeJsonLine } from "./jsonl.ts";
import { parseRpcRequest, RpcProtocolError, type RpcServerMessage, rpcErrorResponse } from "./protocol.ts";

export type { RpcMethodCatalog, RpcSession } from "./dispatcher.ts";

/** JSONL process adapter. Protocol dispatch belongs to RpcDispatcher and is transport independent. */
export interface RpcServerOptions extends RpcDispatcherOptions {
	readonly input: Readable;
	readonly output: Writable;
	readonly maxLineBytes?: number;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

export class RpcServer {
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly onError: (error: Error) => void;
	private readonly decoder: JsonlLineDecoder;
	private readonly dispatcher: RpcDispatcher;
	private readonly requests = new Set<Promise<void>>();
	private readonly finishedPromise: Promise<void>;
	private resolveFinished?: () => void;
	private unsubscribe?: () => void;
	private shutdownPromise?: Promise<void>;
	private started = false;
	private shuttingDown = false;
	private writeChain = Promise.resolve();
	private readonly legacySession?: RpcSession;

	constructor(options: RpcServerOptions) {
		this.input = options.input;
		this.output = options.output;
		this.onError = options.onError ?? (() => undefined);
		this.legacySession = "state" in options.session ? undefined : options.session;
		this.dispatcher = new RpcDispatcher(options);
		this.decoder = new JsonlLineDecoder((line) => this.acceptLine(line), { maxLineBytes: options.maxLineBytes });
		this.finishedPromise = new Promise((resolve) => {
			this.resolveFinished = resolve;
		});
	}

	finished(): Promise<void> {
		return this.finishedPromise;
	}
	/** Forwards a structured interaction request to the negotiated RPC client. */
	requestInteraction(
		input: Omit<UserInteractionInput, "requestId"> & { readonly requestId?: string },
		signal?: AbortSignal,
	): Promise<UserInteractionResult> {
		return this.dispatcher.requestInteraction(input, signal);
	}
	start(): void {
		if (this.started) throw new Error("RPC server is already started.");
		this.started = true;
		this.unsubscribe = this.dispatcher.subscribe((message) => {
			if (!this.shuttingDown) void this.write(message).catch(this.onError);
		});
		this.input.on("data", this.handleData);
		this.input.once("end", this.handleEnd);
		this.input.once("error", this.handleInputError);
	}
	stop(): void {
		void this.shutdown().catch(this.onError);
	}
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shuttingDown = true;
		this.started = false;
		this.input.off("data", this.handleData);
		this.input.off("end", this.handleEnd);
		this.input.off("error", this.handleInputError);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.shutdownPromise = this.finishShutdown();
		return this.shutdownPromise;
	}
	private async finishShutdown(): Promise<void> {
		try {
			await this.dispatcher.dispose();
			await Promise.allSettled([...this.requests]);
			await this.flush();
		} finally {
			this.resolveFinished?.();
			this.resolveFinished = undefined;
		}
	}
	private readonly handleData = (chunk: string | Buffer): void => {
		try {
			this.decoder.push(chunk);
		} catch (cause) {
			const error = errorFrom(cause);
			this.onError(error);
			void this.writeError(undefined, "INVALID_REQUEST", error.message);
			this.stop();
		}
	};
	private readonly handleEnd = (): void => {
		try {
			this.decoder.end();
		} catch (cause) {
			this.onError(errorFrom(cause));
		}
		void this.shutdown().catch(this.onError);
	};
	private readonly handleInputError = (cause: Error): void => {
		this.onError(cause);
		void this.shutdown().catch(this.onError);
	};
	private acceptLine(line: string): void {
		if (this.shuttingDown) return;
		let request: import("./protocol.ts").RpcRequest;
		try {
			request = parseRpcRequest(this.legacyRequest(line));
		} catch (cause) {
			const error =
				cause instanceof RpcProtocolError
					? cause
					: new RpcProtocolError("INVALID_REQUEST", "RPC request validation failed.");
			void this.write(rpcErrorResponse(error)).catch(this.onError);
			return;
		}
		const work = this.dispatcher
			.dispatch(request)
			.then((response) => this.write(response))
			.catch((cause) => this.onError(errorFrom(cause)))
			.finally(() => this.requests.delete(work));
		this.requests.add(work);
	}
	/** Keeps the v1 wire format usable for embedders that still expose RpcSession. */
	private legacyRequest(line: string): string {
		if (!this.legacySession) return line;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return line;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) return line;
		const request = value as { method?: unknown; params?: unknown };
		if (typeof request.method !== "string" || typeof request.params !== "object" || request.params === null)
			return line;
		const params = { ...(request.params as Record<string, unknown>) };
		const sessionMethods = new Set([
			"prompt",
			"steer",
			"retry",
			"compact",
			"cancel",
			"get_operation",
			"get_transcript",
			"get_tree",
			"navigate_tree",
			"set_model",
			"set_runtime",
			"set_thinking_level",
			"set_compaction_enabled",
			"get_usage",
			"approve_tool",
			"respond_interaction",
			"create_attachment",
			"run_command",
		]);
		if (sessionMethods.has(request.method) && params.sessionId === undefined)
			params.sessionId = this.legacySession.sessionId;
		if ((request.method === "cancel" || request.method === "get_operation") && params.runId === undefined)
			params.runId = typeof params.requestId === "string" ? params.requestId : "legacy-run";
		return JSON.stringify({ ...(value as Record<string, unknown>), params });
	}
	private writeError(id: string | undefined, code: "INVALID_REQUEST", message: string): Promise<void> {
		return this.write({ version: 1, kind: "response", ...(id ? { id } : {}), ok: false, error: { code, message } });
	}
	private write(message: RpcServerMessage): Promise<void> {
		const write = this.writeChain.then(
			() =>
				new Promise<void>((resolve, reject) =>
					this.output.write(serializeJsonLine(message), (error) => (error ? reject(error) : resolve())),
				),
		);
		this.writeChain = write.catch(() => undefined);
		return write;
	}
	private flush(): Promise<void> {
		return this.writeChain.then(
			() => new Promise((resolve, reject) => this.output.write("", (error) => (error ? reject(error) : resolve()))),
		);
	}
}
