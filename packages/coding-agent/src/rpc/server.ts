import type { Readable, Writable } from "node:stream";
import type { AssistantMessage, Message } from "@di-code/ai";
import type { AgentSessionListener } from "../core/session.ts";
import { JsonlLineDecoder, serializeJsonLine } from "./jsonl.ts";
import {
	parseRpcRequest,
	RPC_PROTOCOL_VERSION,
	type RpcErrorCode,
	RpcProtocolError,
	type RpcRequest,
	type RpcServerMessage,
	rpcErrorResponse,
} from "./protocol.ts";

export interface RpcSession {
	readonly sessionId: string;
	readonly modelId: string;
	readonly isStreaming: boolean;
	readonly transcript: readonly Message[];
	prompt(text: string, signal?: AbortSignal): Promise<AssistantMessage>;
	subscribeSession(listener: AgentSessionListener): () => void;
}

export interface RpcServerOptions {
	readonly session: RpcSession;
	readonly input: Readable;
	readonly output: Writable;
	readonly onError?: (error: Error) => void;
	readonly maxLineBytes?: number;
}

interface ActivePrompt {
	readonly requestId: string;
	readonly controller: AbortController;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

export class RpcServer {
	private readonly session: RpcSession;
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly onError: (error: Error) => void;
	private readonly decoder: JsonlLineDecoder;
	private readonly inFlightIds = new Set<string>();
	private activePrompt?: ActivePrompt;
	private unsubscribeSession?: () => void;
	private started = false;

	constructor(options: RpcServerOptions) {
		this.session = options.session;
		this.input = options.input;
		this.output = options.output;
		this.onError = options.onError ?? (() => undefined);
		this.decoder = new JsonlLineDecoder((line) => this.acceptLine(line), {
			maxLineBytes: options.maxLineBytes,
		});
	}

	start(): void {
		if (this.started) throw new Error("RPC server is already started.");
		this.started = true;
		this.unsubscribeSession = this.session.subscribeSession(async (event) => {
			const active = this.activePrompt;
			if (!active) return;
			await this.write({
				version: RPC_PROTOCOL_VERSION,
				kind: "event",
				requestId: active.requestId,
				event,
			});
		});
		this.input.on("data", this.handleData);
		this.input.once("end", this.handleEnd);
		this.input.once("error", this.handleInputError);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.input.off("data", this.handleData);
		this.input.off("end", this.handleEnd);
		this.input.off("error", this.handleInputError);
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.activePrompt?.controller.abort();
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
		this.stop();
	};

	private readonly handleInputError = (cause: Error): void => {
		this.onError(cause);
		this.stop();
	};

	private acceptLine(line: string): void {
		let request: RpcRequest;
		try {
			request = parseRpcRequest(line);
		} catch (cause) {
			const protocolError =
				cause instanceof RpcProtocolError
					? cause
					: new RpcProtocolError("INVALID_REQUEST", "RPC request validation failed.");
			void this.write(rpcErrorResponse(protocolError)).catch(this.onError);
			return;
		}

		if (this.inFlightIds.has(request.id)) {
			void this.writeError(request.id, "INVALID_REQUEST", "RPC request id is already in flight.");
			return;
		}
		this.inFlightIds.add(request.id);
		void this.handleRequest(request)
			.catch((cause) => this.onError(errorFrom(cause)))
			.finally(() => this.inFlightIds.delete(request.id));
	}

	private async handleRequest(request: RpcRequest): Promise<void> {
		switch (request.method) {
			case "get_state":
				await this.write({
					version: RPC_PROTOCOL_VERSION,
					kind: "response",
					id: request.id,
					ok: true,
					result: {
						method: "get_state",
						state: {
							sessionId: this.session.sessionId,
							modelId: this.session.modelId,
							isStreaming: this.session.isStreaming,
							messageCount: this.session.transcript.length,
						},
					},
				});
				return;
			case "cancel": {
				const active = this.activePrompt;
				const cancelled = active?.requestId === request.params.requestId;
				if (cancelled) active.controller.abort();
				await this.write({
					version: RPC_PROTOCOL_VERSION,
					kind: "response",
					id: request.id,
					ok: true,
					result: { method: "cancel", cancelled },
				});
				return;
			}
			case "prompt":
				await this.handlePrompt(request);
		}
	}

	private async handlePrompt(request: Extract<RpcRequest, { method: "prompt" }>): Promise<void> {
		if (this.activePrompt || this.session.isStreaming) {
			await this.writeError(request.id, "BUSY", "The RPC session is already processing a prompt.");
			return;
		}
		const active: ActivePrompt = { requestId: request.id, controller: new AbortController() };
		this.activePrompt = active;
		try {
			const message = await this.session.prompt(request.params.message, active.controller.signal);
			await this.write({
				version: RPC_PROTOCOL_VERSION,
				kind: "response",
				id: request.id,
				ok: true,
				result: { method: "prompt", message },
			});
		} catch (cause) {
			const error = errorFrom(cause);
			const aborted = active.controller.signal.aborted || error.name === "AbortError";
			await this.writeError(
				request.id,
				aborted ? "CANCELLED" : "INTERNAL_ERROR",
				aborted ? "The RPC prompt was cancelled." : "The RPC prompt failed.",
			);
			if (!aborted) this.onError(error);
		} finally {
			if (this.activePrompt === active) this.activePrompt = undefined;
		}
	}

	private writeError(id: string | undefined, code: RpcErrorCode, message: string): Promise<void> {
		return this.write({
			version: RPC_PROTOCOL_VERSION,
			kind: "response",
			...(id === undefined ? {} : { id }),
			ok: false,
			error: { code, message },
		});
	}

	private write(message: RpcServerMessage): Promise<void> {
		return new Promise((resolve, reject) => {
			this.output.write(serializeJsonLine(message), (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}
}
