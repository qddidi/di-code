import type { ImageContent } from "@di-code/ai";
import type { InteractiveController, InteractiveInput, InteractiveViewEvent } from "./interactive/controller.ts";

export const WEB_PROTOCOL_VERSION = 1 as const;
export const WEB_MAX_ID_LENGTH = 128;
export const WEB_MAX_TOKEN_LENGTH = 4096;
export const WEB_MAX_PAYLOAD_BYTES = 1_048_576;
export const WEB_DEFAULT_REPLAY_LIMIT = 256;

export type WebAction =
	| { readonly type: "submit"; readonly input: InteractiveInput }
	| { readonly type: "steer"; readonly input: InteractiveInput }
	| { readonly type: "cancel" }
	| { readonly type: "retry" }
	| { readonly type: "run_command"; readonly name: string; readonly args: string }
	| { readonly type: "select_model"; readonly modelId: string }
	| { readonly type: "open_session"; readonly sessionId: string }
	| { readonly type: "create_session" }
	| { readonly type: "compact" }
	| { readonly type: "slot_action"; readonly slotId: string; readonly payload?: unknown };
export type WebActionType = WebAction["type"];

export type WebClientMessage =
	| {
			readonly version: typeof WEB_PROTOCOL_VERSION;
			readonly kind: "connect";
			readonly requestId: string;
			readonly token: string;
			readonly frontendId: string;
			readonly lastEventId?: number;
	  }
	| {
			readonly version: typeof WEB_PROTOCOL_VERSION;
			readonly kind: "action";
			readonly requestId: string;
			readonly action: WebAction;
			readonly baseEventId?: number;
	  }
	| { readonly version: typeof WEB_PROTOCOL_VERSION; readonly kind: "disconnect"; readonly requestId: string };

export interface WebSlot {
	readonly id: string;
	readonly title: string;
	readonly data: unknown;
}

export interface WebServerHello {
	readonly version: typeof WEB_PROTOCOL_VERSION;
	readonly kind: "hello";
	readonly requestId: string;
	readonly connectionId: string;
	readonly sessionId: string;
	readonly state: unknown;
	readonly slots: readonly WebSlot[];
	readonly eventId: number;
	readonly replayedFrom?: number;
	readonly resyncRequired?: boolean;
}

export interface WebServerEvent {
	readonly version: typeof WEB_PROTOCOL_VERSION;
	readonly kind: "event";
	readonly eventId: number;
	readonly event: InteractiveViewEvent;
}

export interface WebServerMessage {
	readonly version: typeof WEB_PROTOCOL_VERSION;
	readonly kind: "hello" | "event" | "slots" | "response" | "error" | "closed";
	readonly requestId?: string;
	readonly eventId?: number;
	readonly ok?: boolean;
	readonly result?: unknown;
	readonly code?: WebErrorCode;
	readonly message?: string;
	readonly connectionId?: string;
	readonly sessionId?: string;
	readonly state?: unknown;
	readonly slots?: readonly WebSlot[];
	readonly replayedFrom?: number;
	readonly resyncRequired?: boolean;
	readonly event?: InteractiveViewEvent;
}

export type WebErrorCode =
	| "INVALID_MESSAGE"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "EXPIRED"
	| "STALE_EVENT"
	| "INVALID_ACTION"
	| "INTERNAL_ERROR";

export interface WebTransport {
	send(message: string): void;
	close?(code?: number, reason?: string): void;
	onMessage(listener: (message: string) => void): () => void;
	onClose(listener: () => void): () => void;
}

export interface WebAuthorization {
	readonly token: string;
	readonly allowedFrontendIds: readonly string[];
	readonly allowedSlotIds: readonly string[];
	readonly allowedActions?: readonly WebActionType[];
	readonly expiresAt?: number;
}

export interface WebFrontendHostOptions {
	readonly controller: InteractiveController;
	readonly authorization: WebAuthorization;
	readonly replayLimit?: number;
	readonly now?: () => number;
	readonly slotActions?: Readonly<
		Record<string, (payload: unknown, context: { readonly sessionId: string }) => void | Promise<void>>
	>;
}

export class WebProtocolError extends Error {
	readonly code: WebErrorCode;
	constructor(code: WebErrorCode, message: string) {
		super(message);
		this.name = "WebProtocolError";
		this.code = code;
	}
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function utf8ByteLength(value: string): number {
	return typeof TextEncoder === "function" ? new TextEncoder().encode(value).byteLength : value.length;
}

function requiredId(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > WEB_MAX_ID_LENGTH ||
		value.trim() !== value ||
		[...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || code === 0x7f;
		})
	)
		throw new WebProtocolError("INVALID_MESSAGE", `${field} must be a non-empty identifier.`);
	return value;
}

function optionalEventId(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new WebProtocolError("INVALID_MESSAGE", `${field} must be a non-negative safe integer.`);
	return value;
}

function inputValue(value: unknown, field: string): InteractiveInput {
	if (typeof value === "string") {
		if (!value.trim()) throw new WebProtocolError("INVALID_ACTION", `${field} must not be empty.`);
		return value;
	}
	const record = objectRecord(value);
	if (!record || typeof record.text !== "string" || !record.text.trim())
		throw new WebProtocolError("INVALID_ACTION", `${field} must contain non-empty text.`);
	if (record.images === undefined) return { text: record.text };
	if (!Array.isArray(record.images) || record.images.length > 4)
		throw new WebProtocolError("INVALID_ACTION", `${field}.images must contain at most four images.`);
	const images = record.images.map((image, index) => {
		const item = objectRecord(image);
		if (
			!item ||
			item.type !== "image" ||
			typeof item.mimeType !== "string" ||
			typeof item.data !== "string" ||
			item.data.length === 0
		)
			throw new WebProtocolError("INVALID_ACTION", `${field}.images[${index}] is invalid.`);
		return { type: "image", mimeType: item.mimeType, data: item.data } satisfies ImageContent;
	});
	return { text: record.text, images };
}

export function parseWebClientMessage(input: string | unknown): WebClientMessage {
	let value: unknown = input;
	if (typeof input === "string") {
		if (utf8ByteLength(input) > WEB_MAX_PAYLOAD_BYTES)
			throw new WebProtocolError("INVALID_MESSAGE", "Web message is too large.");
		try {
			value = JSON.parse(input);
		} catch {
			throw new WebProtocolError("INVALID_MESSAGE", "Web message must be valid JSON.");
		}
	}
	const record = objectRecord(value);
	if (!record || record.version !== WEB_PROTOCOL_VERSION)
		throw new WebProtocolError("INVALID_MESSAGE", "Unsupported web protocol message.");
	const requestId = requiredId(record.requestId, "requestId");
	if (record.kind === "connect") {
		const token = record.token;
		if (typeof token !== "string" || token.length === 0 || token.length > WEB_MAX_TOKEN_LENGTH)
			throw new WebProtocolError("INVALID_MESSAGE", "connect.token is invalid.");
		return {
			version: WEB_PROTOCOL_VERSION,
			kind: "connect",
			requestId,
			token,
			frontendId: requiredId(record.frontendId, "frontendId"),
			...(optionalEventId(record.lastEventId, "lastEventId") === undefined
				? {}
				: { lastEventId: record.lastEventId as number }),
		};
	}
	if (record.kind === "disconnect") return { version: WEB_PROTOCOL_VERSION, kind: "disconnect", requestId };
	if (record.kind !== "action") throw new WebProtocolError("INVALID_MESSAGE", "Unknown web message kind.");
	const action = objectRecord(record.action);
	if (!action || typeof action.type !== "string")
		throw new WebProtocolError("INVALID_ACTION", "Web action is invalid.");
	let normalized: WebAction;
	switch (action.type) {
		case "submit":
			normalized = { type: "submit", input: inputValue(action.input, "submit.input") };
			break;
		case "steer":
			normalized = { type: "steer", input: inputValue(action.input, "steer.input") };
			break;
		case "cancel":
		case "retry":
		case "create_session":
		case "compact":
			normalized = { type: action.type };
			break;
		case "run_command":
			normalized = {
				type: action.type,
				name: requiredId(action.name, "action.name"),
				args: typeof action.args === "string" ? action.args : "",
			};
			break;
		case "select_model":
			normalized = { type: action.type, modelId: requiredId(action.modelId, "action.modelId") };
			break;
		case "open_session":
			normalized = { type: action.type, sessionId: requiredId(action.sessionId, "action.sessionId") };
			break;
		case "slot_action":
			normalized = { type: action.type, slotId: requiredId(action.slotId, "action.slotId"), payload: action.payload };
			break;
		default:
			throw new WebProtocolError("INVALID_ACTION", "Unknown web action.");
	}
	return {
		version: WEB_PROTOCOL_VERSION,
		kind: "action",
		requestId,
		action: normalized,
		...(optionalEventId(record.baseEventId, "baseEventId") === undefined
			? {}
			: { baseEventId: record.baseEventId as number }),
	};
}

export function parseWebServerMessage(input: string | unknown): WebServerMessage {
	let value: unknown = input;
	if (typeof input === "string") {
		if (utf8ByteLength(input) > WEB_MAX_PAYLOAD_BYTES)
			throw new WebProtocolError("INVALID_MESSAGE", "Web message is too large.");
		try {
			value = JSON.parse(input);
		} catch {
			throw new WebProtocolError("INVALID_MESSAGE", "Web message must be valid JSON.");
		}
	}
	const record = objectRecord(value);
	if (!record || record.version !== WEB_PROTOCOL_VERSION || typeof record.kind !== "string")
		throw new WebProtocolError("INVALID_MESSAGE", "Web server message is invalid.");
	if (!["hello", "event", "slots", "response", "error", "closed"].includes(record.kind))
		throw new WebProtocolError("INVALID_MESSAGE", "Unknown web server message kind.");
	if (record.kind === "event") {
		if (optionalEventId(record.eventId, "eventId") === undefined)
			throw new WebProtocolError("INVALID_MESSAGE", "Web event message must contain eventId.");
		const event = objectRecord(record.event);
		if (!event || typeof event.type !== "string")
			throw new WebProtocolError("INVALID_MESSAGE", "Web event message is invalid.");
	}
	if (record.kind === "slots") {
		if (!Array.isArray(record.slots)) throw new WebProtocolError("INVALID_MESSAGE", "Web slots message is invalid.");
		for (const slot of record.slots) {
			const item = objectRecord(slot);
			if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !Object.hasOwn(item, "data"))
				throw new WebProtocolError("INVALID_MESSAGE", "Web slot is invalid.");
			requiredId(item.id, "slot.id");
		}
	}
	if (record.kind === "error") {
		if (
			typeof record.code !== "string" ||
			![
				"INVALID_MESSAGE",
				"UNAUTHORIZED",
				"FORBIDDEN",
				"EXPIRED",
				"STALE_EVENT",
				"INVALID_ACTION",
				"INTERNAL_ERROR",
			].includes(record.code) ||
			typeof record.message !== "string" ||
			record.message.length === 0
		)
			throw new WebProtocolError("INVALID_MESSAGE", "Web error message is invalid.");
	}
	if (record.kind === "response") {
		requiredId(record.requestId, "requestId");
		if (record.ok !== true) throw new WebProtocolError("INVALID_MESSAGE", "Web response message is invalid.");
	}
	if (record.kind === "hello") {
		requiredId(record.requestId, "requestId");
		requiredId(record.connectionId, "connectionId");
		requiredId(record.sessionId, "sessionId");
		optionalEventId(record.eventId, "eventId");
		if (!Array.isArray(record.slots) || !objectRecord(record.state))
			throw new WebProtocolError("INVALID_MESSAGE", "Web hello message is invalid.");
	}
	return record as unknown as WebServerMessage;
}

function sameSecret(actual: string, expected: string): boolean {
	if (actual.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < actual.length; index++)
		difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
	return difference === 0;
}

function connectionId(): string {
	const cryptoObject = globalThis.crypto as { readonly randomUUID?: () => string } | undefined;
	if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();
	return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function validateAuthorization(value: WebAuthorization): void {
	if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > WEB_MAX_TOKEN_LENGTH)
		throw new Error("Web authorization token is invalid.");
	if ([...value.token].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === "\u007f"))
		throw new Error("Web authorization token contains a control character.");
	for (const id of value.allowedFrontendIds) requiredId(id, "allowedFrontendIds item");
	for (const id of value.allowedSlotIds) requiredId(id, "allowedSlotIds item");
	if (
		value.allowedActions?.some(
			(action) =>
				![
					"submit",
					"steer",
					"cancel",
					"retry",
					"run_command",
					"select_model",
					"open_session",
					"create_session",
					"compact",
					"slot_action",
				].includes(action),
		)
	)
		throw new Error("Web authorization contains an unknown action.");
	if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0))
		throw new Error("Web authorization expiry must be a non-negative safe integer.");
}

function cloneSlots(controller: InteractiveController, allowed: readonly string[]): WebSlot[] {
	const allow = new Set(allowed);
	const slots: WebSlot[] = [];
	for (const panel of controller.ui.panels) {
		if (!allow.has(panel.id)) continue;
		try {
			slots.push({ id: panel.id, title: panel.title, data: structuredClone(panel.data) });
		} catch {
			// Non-serializable plugin panel data is not exposed to the browser.
		}
	}
	return slots;
}

interface EventEnvelope {
	readonly eventId: number;
	readonly event: InteractiveViewEvent;
}

/** Versioned Web projection. Disconnecting a page only detaches its transport. */
export class WebFrontendHost {
	private readonly controller: InteractiveController;
	private readonly authorization: WebAuthorization;
	private readonly replayLimit: number;
	private readonly now: () => number;
	private readonly slotActions: WebFrontendHostOptions["slotActions"];
	private readonly events: EventEnvelope[] = [];
	private readonly connections = new Set<WebConnection>();
	private eventId = 0;
	private disposed = false;
	private readonly unsubscribeController: { dispose(): void };

	constructor(options: WebFrontendHostOptions) {
		validateAuthorization(options.authorization);
		this.controller = options.controller;
		this.authorization = {
			...options.authorization,
			allowedFrontendIds: [...options.authorization.allowedFrontendIds],
			allowedSlotIds: [...options.authorization.allowedSlotIds],
			...(options.authorization.allowedActions === undefined
				? {}
				: { allowedActions: [...options.authorization.allowedActions] }),
		};
		this.replayLimit = Math.max(1, Math.min(options.replayLimit ?? WEB_DEFAULT_REPLAY_LIMIT, 4096));
		this.now = options.now ?? Date.now;
		this.slotActions = options.slotActions;
		this.unsubscribeController = options.controller.subscribe((event) => this.publish(event));
	}

	attach(transport: WebTransport): WebConnection {
		if (this.disposed) throw new Error("Web frontend host is disposed.");
		const connection = new WebConnection(this, transport);
		this.connections.add(connection);
		connection.onDispose = () => this.connections.delete(connection);
		return connection;
	}

	get latestEventId(): number {
		return this.eventId;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const connection of [...this.connections]) connection.dispose();
		this.unsubscribeController.dispose();
		this.controller.dispose();
	}

	private publish(event: InteractiveViewEvent): void {
		if (this.disposed) return;
		const envelope = { eventId: ++this.eventId, event: structuredClone(event) };
		this.events.push(envelope);
		while (this.events.length > this.replayLimit) this.events.shift();
		for (const connection of this.connections) {
			connection.sendEvent(envelope);
			if (connection.authorized) connection.sendSlots(cloneSlots(this.controller, this.authorization.allowedSlotIds));
		}
	}

	private authorize(token: string, frontendId: string): void {
		if (this.authorization.expiresAt !== undefined && this.now() >= this.authorization.expiresAt)
			throw new WebProtocolError("EXPIRED", "Web authorization has expired.");
		if (!sameSecret(token, this.authorization.token))
			throw new WebProtocolError("UNAUTHORIZED", "Web authorization failed.");
		if (!this.authorization.allowedFrontendIds.includes(frontendId))
			throw new WebProtocolError("FORBIDDEN", "Frontend is not authorized.");
	}

	_handleConnect(connection: WebConnection, request: Extract<WebClientMessage, { kind: "connect" }>): void {
		this.authorize(request.token, request.frontendId);
		connection.authorized = true;
		const current = this.eventId;
		const replayFrom = request.lastEventId;
		const oldest = this.events[0]?.eventId;
		const canReplay = replayFrom !== undefined && (oldest === undefined || replayFrom >= oldest - 1);
		connection.send({
			version: WEB_PROTOCOL_VERSION,
			kind: "hello",
			requestId: request.requestId,
			connectionId: connection.id,
			sessionId: this.controller.state.sessionId,
			state: structuredClone(this.controller.state),
			slots: cloneSlots(this.controller, this.authorization.allowedSlotIds),
			eventId: current,
			...(canReplay && replayFrom !== undefined ? { replayedFrom: replayFrom } : {}),
			...(replayFrom !== undefined && !canReplay ? { resyncRequired: true } : {}),
		});
		if (canReplay && replayFrom !== undefined)
			for (const event of this.events) if (event.eventId > replayFrom) connection.sendEvent(event);
	}

	async _handleAction(
		connection: WebConnection,
		request: Extract<WebClientMessage, { kind: "action" }>,
	): Promise<void> {
		if (!connection.authorized) throw new WebProtocolError("UNAUTHORIZED", "Connect before sending actions.");
		if (
			this.authorization.allowedActions !== undefined &&
			!this.authorization.allowedActions.includes(request.action.type)
		)
			throw new WebProtocolError("FORBIDDEN", "Web action is not authorized.");
		if (request.baseEventId !== undefined && request.baseEventId < this.eventId - this.replayLimit)
			throw new WebProtocolError("STALE_EVENT", "Action references an expired event.");
		const action = request.action;
		switch (action.type) {
			case "submit":
				await this.controller.submit(action.input);
				break;
			case "steer":
				this.controller.steer(action.input);
				break;
			case "cancel":
				this.controller.cancel();
				break;
			case "retry":
				await this.controller.retry();
				break;
			case "run_command":
				await this.controller.runCommand(action.name, action.args);
				break;
			case "select_model":
				this.controller.selectModel(action.modelId);
				break;
			case "open_session":
				await this.controller.openSession(action.sessionId);
				break;
			case "create_session":
				await this.controller.createSession();
				break;
			case "compact":
				await this.controller.requestCompaction();
				break;
			case "slot_action":
				if (!this.authorization.allowedSlotIds.includes(action.slotId) || !this.slotActions?.[action.slotId])
					throw new WebProtocolError("FORBIDDEN", "Slot action is not authorized.");
				await this.slotActions[action.slotId](action.payload, { sessionId: this.controller.state.sessionId });
				break;
		}
		connection.send({
			version: WEB_PROTOCOL_VERSION,
			kind: "response",
			requestId: request.requestId,
			ok: true,
			result: { accepted: true, eventId: this.eventId },
		});
	}
}

export class WebConnection {
	readonly id = connectionId();
	authorized = false;
	onDispose?: () => void;
	private readonly transport: WebTransport;
	private readonly removeMessage: () => void;
	private readonly removeClose: () => void;
	private disposed = false;
	constructor(host: WebFrontendHost, transport: WebTransport) {
		this.transport = transport;
		this.removeMessage = transport.onMessage((raw) => {
			try {
				const message = parseWebClientMessage(raw);
				if (message.kind === "connect") host._handleConnect(this, message);
				else if (message.kind === "disconnect") this.dispose();
				else void host._handleAction(this, message).catch((cause) => this.error(cause));
			} catch (cause) {
				this.error(cause);
			}
		});
		this.removeClose = transport.onClose(() => this.dispose());
	}
	send(message: WebServerMessage): void {
		if (!this.disposed) this.transport.send(JSON.stringify(message));
	}
	sendEvent(envelope: EventEnvelope): void {
		this.send({ version: WEB_PROTOCOL_VERSION, kind: "event", eventId: envelope.eventId, event: envelope.event });
	}
	sendSlots(slots: readonly WebSlot[]): void {
		this.send({ version: WEB_PROTOCOL_VERSION, kind: "slots", slots });
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.transport.send(JSON.stringify({ version: WEB_PROTOCOL_VERSION, kind: "closed" } satisfies WebServerMessage));
		} catch {
			// The page may already have disappeared; cleanup must still run.
		} finally {
			this.removeMessage();
			this.removeClose();
			try {
				this.transport.close?.(1000, "page detached");
			} catch {
				// Transport teardown is best effort.
			} finally {
				this.onDispose?.();
			}
		}
	}
	private error(cause: unknown): void {
		const error =
			cause instanceof WebProtocolError
				? cause
				: new WebProtocolError("INTERNAL_ERROR", cause instanceof Error ? cause.message : String(cause));
		this.send({ version: WEB_PROTOCOL_VERSION, kind: "error", code: error.code, message: error.message });
	}
}

export type WebClientEvent =
	| { readonly type: "hello"; readonly message: WebServerHello }
	| { readonly type: "event"; readonly message: WebServerEvent }
	| { readonly type: "slots"; readonly slots: readonly WebSlot[] }
	| { readonly type: "error"; readonly code: WebErrorCode; readonly message: string }
	| { readonly type: "closed" };

/** Small browser-side state adapter. It never owns or disposes the Host. */
export class WebClient {
	private readonly transport: WebTransport;
	private readonly listeners = new Set<(event: WebClientEvent) => void>();
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
	private readonly removeMessage: () => void;
	private readonly removeClose: () => void;
	private closed = false;
	private _state: unknown;
	private _slots: readonly WebSlot[] = [];
	private _eventId = 0;
	constructor(transport: WebTransport) {
		this.transport = transport;
		this.removeMessage = transport.onMessage((raw) => this.accept(raw));
		this.removeClose = transport.onClose(() => this.fail(new Error("Web transport closed.")));
	}
	get state(): unknown {
		return this._state;
	}
	get slots(): readonly WebSlot[] {
		return this._slots;
	}
	get eventId(): number {
		return this._eventId;
	}
	subscribe(listener: (event: WebClientEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	connect(token: string, frontendId: string, lastEventId?: number): Promise<WebServerHello> {
		return this.request({
			version: WEB_PROTOCOL_VERSION,
			kind: "connect",
			requestId: connectionId(),
			token,
			frontendId,
			...(lastEventId === undefined ? {} : { lastEventId }),
		}).then((message) => message as WebServerHello);
	}
	action(action: WebAction, baseEventId = this._eventId): Promise<void> {
		return this.request({
			version: WEB_PROTOCOL_VERSION,
			kind: "action",
			requestId: connectionId(),
			action,
			baseEventId,
		}).then(() => undefined);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.removeMessage();
		this.removeClose();
		this.transport.close?.(1000, "client closed");
		for (const pending of this.pending.values()) pending.reject(new Error("Web client is closed."));
		this.pending.clear();
	}
	private request(message: WebClientMessage): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("Web client is closed."));
		return new Promise((resolve, reject) => {
			this.pending.set(message.requestId, { resolve, reject });
			try {
				this.transport.send(JSON.stringify(message));
			} catch (cause) {
				this.pending.delete(message.requestId);
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
	}
	private accept(raw: string): void {
		try {
			const message = parseWebServerMessage(raw);
			if (message.kind === "hello") {
				this._state = structuredClone(message.state);
				this._slots = [...(message.slots ?? [])];
				this._eventId = message.eventId ?? this._eventId;
				this.resolve(message.requestId, message);
				this.emit({ type: "hello", message: message as WebServerHello });
			} else if (message.kind === "event") {
				this._eventId = Math.max(this._eventId, message.eventId ?? 0);
				this.emit({ type: "event", message: message as WebServerEvent });
			} else if (message.kind === "slots") {
				this._slots = [...(message.slots ?? [])];
				this.emit({ type: "slots", slots: this._slots });
			} else if (message.kind === "response") this.resolve(message.requestId, message);
			else if (message.kind === "error") {
				const error = new WebProtocolError(message.code ?? "INTERNAL_ERROR", message.message ?? "Web request failed.");
				this.reject(message.requestId, error);
				this.emit({ type: "error", code: error.code, message: error.message });
			} else this.emit({ type: "closed" });
		} catch (cause) {
			this.fail(cause instanceof Error ? cause : new Error(String(cause)));
		}
	}
	private resolve(requestId: string | undefined, value: unknown): void {
		if (!requestId) return;
		const pending = this.pending.get(requestId);
		if (pending) {
			this.pending.delete(requestId);
			pending.resolve(value);
		}
	}
	private reject(requestId: string | undefined, cause: Error): void {
		if (!requestId) return;
		const pending = this.pending.get(requestId);
		if (pending) {
			this.pending.delete(requestId);
			pending.reject(cause);
		}
	}
	private emit(event: WebClientEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	private fail(cause: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.removeMessage();
		this.removeClose();
		for (const pending of this.pending.values()) pending.reject(cause);
		this.pending.clear();
		this.emit({ type: "error", code: "INTERNAL_ERROR", message: cause.message });
	}
}

export function createWebAuthorization(
	options: Omit<WebAuthorization, "allowedFrontendIds" | "allowedSlotIds"> & {
		allowedFrontendIds?: readonly string[];
		allowedSlotIds?: readonly string[];
	},
): WebAuthorization {
	const value: WebAuthorization = {
		token: options.token,
		allowedFrontendIds: [...(options.allowedFrontendIds ?? [])],
		allowedSlotIds: [...(options.allowedSlotIds ?? [])],
		...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
	};
	validateAuthorization(value);
	return value;
}
