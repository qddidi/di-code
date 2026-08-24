import type { Readable, Writable } from "node:stream";
import { RpcDispatcher, type RpcDispatcherOptions } from "./dispatcher.ts";
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

	constructor(options: RpcServerOptions) {
		this.input = options.input;
		this.output = options.output;
		this.onError = options.onError ?? (() => undefined);
		this.dispatcher = new RpcDispatcher(options);
		this.decoder = new JsonlLineDecoder((line) => this.acceptLine(line), { maxLineBytes: options.maxLineBytes });
		this.finishedPromise = new Promise((resolve) => {
			this.resolveFinished = resolve;
		});
	}

	finished(): Promise<void> {
		return this.finishedPromise;
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
			request = parseRpcRequest(line);
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
