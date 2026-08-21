import type { InteractiveControllerState } from "./interactive/controller.ts";
import {
	connectWebSocketTransport,
	type WebAction,
	WebClient,
	type WebClientEvent,
	type WebServerHello,
	type WebSocketConstructor,
	type WebTransport,
} from "./web.ts";

/** Small DOM surface so the browser frontend remains usable with SSR and DOM test doubles. */
export interface WebElementLike {
	className: string;
	textContent: string | null;
	value?: string;
	disabled?: boolean;
	setAttribute(name: string, value: string): void;
	append(...children: WebElementLike[]): void;
	replaceChildren(...children: WebElementLike[]): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface WebDocumentLike {
	readonly body: WebElementLike;
	createElement(tagName: string): WebElementLike;
}

export interface WebFrontendOptions {
	readonly client: WebClient;
	readonly token: string;
	readonly frontendId: string;
	readonly document?: WebDocumentLike;
	readonly root?: WebElementLike;
	readonly title?: string;
}

export interface WebFrontendConnectionOptions {
	readonly url: string;
	readonly token: string;
	readonly frontendId: string;
	readonly document?: WebDocumentLike;
	readonly root?: WebElementLike;
	readonly title?: string;
	readonly protocols?: string | string[];
	readonly WebSocket?: WebSocketConstructor;
}

const WEB_FRONTEND_STYLE = `
.di-web-app{box-sizing:border-box;min-height:100%;display:flex;flex-direction:column;background:#f6f7f9;color:#17202a;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.di-web-app *{box-sizing:border-box}.di-web-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid #d8dde5;background:#fff}
.di-web-title{margin:0;font-size:18px;font-weight:650}.di-web-status{font-size:13px;color:#596579}.di-web-status[data-state=error]{color:#b42318}
.di-web-main{width:min(960px,100%);margin:0 auto;padding:24px 20px 16px;flex:1}.di-web-transcript{display:flex;flex-direction:column;gap:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.di-web-message{padding:12px 14px;border:1px solid #d8dde5;border-radius:6px;background:#fff}.di-web-message[data-role=user]{border-left:3px solid #5b6b85}.di-web-message[data-role=assistant]{border-left:3px solid #147d64}.di-web-process{margin:16px 0;color:#596579;font-size:13px}.di-web-error{margin:12px 0;padding:10px 12px;border:1px solid #efb4ae;border-radius:6px;background:#fff5f4;color:#8e2117}
.di-web-composer{border-top:1px solid #d8dde5;background:#fff;padding:14px 20px;position:sticky;bottom:0}.di-web-composer-inner{width:min(960px,100%);margin:0 auto;display:flex;flex-direction:column;gap:10px}
.di-web-input{width:100%;min-height:72px;max-height:240px;resize:vertical;padding:10px 12px;border:1px solid #aeb8c6;border-radius:5px;font:inherit;color:inherit;background:#fff}.di-web-input:focus{outline:2px solid #6d8fc7;outline-offset:1px}
.di-web-actions{display:flex;flex-wrap:wrap;gap:8px}.di-web-button{border:1px solid #aeb8c6;border-radius:5px;padding:7px 12px;background:#fff;color:#17202a;font:inherit;cursor:pointer}.di-web-button:hover:not(:disabled){background:#f0f3f7}.di-web-button[data-primary=true]{border-color:#174ea6;background:#174ea6;color:#fff}.di-web-button:disabled{cursor:not-allowed;opacity:.5}
@media (max-width:600px){.di-web-header{padding:12px 14px}.di-web-main{padding:16px 14px 12px}.di-web-composer{padding:12px 14px}.di-web-button{flex:1 1 auto}}
`;

function element(document: WebDocumentLike, tag: string, className: string, text?: string): WebElementLike {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function stateFrom(value: unknown): InteractiveControllerState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as InteractiveControllerState;
}

/** A complete browser UI for the versioned Web projection. It owns DOM and client state, never the Host. */
export class WebFrontendApp {
	private readonly client: WebClient;
	private readonly token: string;
	private readonly frontendId: string;
	private readonly document?: WebDocumentLike;
	private readonly root?: WebElementLike;
	private readonly title: string;
	private unsubscribe?: () => void;
	private mounted = false;
	private disposed = false;
	private status = "Disconnected";
	private currentState: InteractiveControllerState | undefined;
	private input?: WebElementLike;
	private transcript?: WebElementLike;
	private process?: WebElementLike;
	private error?: WebElementLike;
	private statusNode?: WebElementLike;
	private actionButtons = new Map<string, WebElementLike>();

	constructor(options: WebFrontendOptions) {
		this.client = options.client;
		this.token = options.token;
		this.frontendId = options.frontendId;
		this.document = options.document;
		this.root = options.root;
		this.title = options.title ?? "di-code";
	}

	get state(): InteractiveControllerState | undefined {
		return this.currentState;
	}

	/** Mounts the responsive UI and performs the initial authenticated handshake. */
	async start(): Promise<WebServerHello> {
		if (this.disposed) throw new Error("Web frontend is disposed.");
		this.mount();
		this.unsubscribe ??= this.client.subscribe((event) => this.accept(event));
		try {
			const hello = await this.client.connect(this.token, this.frontendId, this.client.eventId);
			this.currentState = stateFrom(hello.state);
			this.status = "Connected";
			this.render();
			return hello;
		} catch (cause) {
			this.setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	/** Reconnects the browser client, replaying from the last event known by this page. */
	async reconnect(transport: WebTransport): Promise<WebServerHello> {
		if (this.disposed) throw new Error("Web frontend is disposed.");
		this.status = "Reconnecting";
		this.render();
		try {
			const hello = await this.client.reconnect(transport, this.token, this.frontendId);
			this.currentState = stateFrom(hello.state);
			this.status = hello.resyncRequired ? "Connected (synced)" : "Connected";
			this.render();
			return hello;
		} catch (cause) {
			this.setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.client.close();
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		if (!this.document || !this.root) return;
		const style = element(this.document, "style", "");
		style.textContent = WEB_FRONTEND_STYLE;
		const app = element(this.document, "div", "di-web-app");
		const header = element(this.document, "header", "di-web-header");
		header.setAttribute("role", "banner");
		header.append(element(this.document, "h1", "di-web-title", this.title));
		this.statusNode = element(this.document, "span", "di-web-status", this.status);
		this.statusNode.setAttribute("aria-live", "polite");
		header.append(this.statusNode);
		const main = element(this.document, "main", "di-web-main");
		this.transcript = element(this.document, "section", "di-web-transcript");
		this.transcript.setAttribute("aria-live", "polite");
		this.transcript.setAttribute("aria-label", "Conversation");
		this.process = element(this.document, "div", "di-web-process");
		this.error = element(this.document, "div", "di-web-error");
		this.error.setAttribute("role", "alert");
		main.append(this.transcript, this.process, this.error);
		const composer = element(this.document, "form", "di-web-composer");
		composer.addEventListener("submit", (event) => {
			if (typeof event === "object" && event !== null && "preventDefault" in event) {
				(event as { preventDefault(): void }).preventDefault();
			}
			void this.submit();
		});
		const composerInner = element(this.document, "div", "di-web-composer-inner");
		this.input = element(this.document, "textarea", "di-web-input");
		this.input.setAttribute("aria-label", "Message");
		this.input.setAttribute("placeholder", "Send a message");
		composerInner.append(this.input);
		const actions = element(this.document, "div", "di-web-actions");
		for (const [key, label, handler, primary] of [
			["submit", "Send", () => void this.submit(), true],
			["steer", "Steer", () => void this.steer(), false],
			["cancel", "Cancel", () => this.client.action({ type: "cancel" }), false],
			["retry", "Retry", () => void this.client.action({ type: "retry" }), false],
			["compact", "Compact", () => void this.client.action({ type: "compact" }), false],
			["create_session", "New session", () => void this.client.action({ type: "create_session" }), false],
		] as const) {
			const button = element(this.document, "button", "di-web-button", label);
			button.setAttribute("type", key === "submit" ? "submit" : "button");
			button.setAttribute("data-primary", String(primary));
			if (key !== "submit") button.addEventListener("click", () => void this.runAction(handler));
			actions.append(button);
			this.actionButtons.set(key, button);
		}
		composerInner.append(actions);
		composer.append(composerInner);
		app.append(header, main, composer);
		this.root.replaceChildren(style, app);
	}

	private accept(event: WebClientEvent): void {
		if (event.type === "hello") {
			this.currentState = stateFrom(event.message.state);
			this.status = event.message.resyncRequired ? "Connected (synced)" : "Connected";
		} else if (event.type === "event") {
			if (event.message.event.type === "state") this.currentState = event.message.event.state;
		} else if (event.type === "error") {
			this.status = "Connection error";
			this.setError(event.message);
		} else if (event.type === "closed") this.status = "Disconnected";
		this.render();
	}

	private async submit(): Promise<void> {
		const text = this.input?.value?.trim() ?? "";
		if (!text) return;
		if (this.input) this.input.value = "";
		await this.runAction(() => this.client.action({ type: "submit", input: text }));
	}

	private async steer(): Promise<void> {
		const text = this.input?.value?.trim() ?? "";
		if (!text) return;
		if (this.input) this.input.value = "";
		await this.runAction(() => this.client.action({ type: "steer", input: text }));
	}

	private async runAction(action: () => Promise<unknown> | unknown): Promise<void> {
		try {
			await action();
		} catch (cause) {
			this.setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	private setError(message: string): void {
		if (this.error) this.error.textContent = message;
		this.status = "Connection error";
		this.render();
	}

	private render(): void {
		if (this.statusNode) {
			this.statusNode.textContent = this.status;
			this.statusNode.setAttribute("data-state", this.status.includes("error") ? "error" : "ok");
		}
		if (!this.transcript || !this.process || !this.document) return;
		const state = this.currentState;
		this.transcript.replaceChildren();
		for (const item of state?.messageItems ?? []) {
			if (item.role !== "user" && item.role !== "assistant") continue;
			const message = element(this.document, "article", "di-web-message", item.text);
			message.setAttribute("data-role", item.role);
			this.transcript.append(message);
		}
		this.process.textContent = [
			...(state?.toolStatus ?? []),
			...(state?.streamingText ? [state.streamingText] : []),
			...(state?.queue?.length ? [`Queued: ${state.queue.length}`] : []),
		].join("\n");
		if (this.error && !state?.error && this.status !== "Connection error") this.error.textContent = "";
		if (state?.error && this.error) this.error.textContent = state.error;
		for (const [key, button] of this.actionButtons) {
			button.disabled = Boolean(state?.busy) && ["submit", "retry", "compact", "create_session"].includes(key);
		}
	}
}

/** Convenience factory for a browser page that owns a WebSocket client and DOM frontend. */
export async function createWebFrontendApp(options: WebFrontendConnectionOptions): Promise<WebFrontendApp> {
	const transport = await connectWebSocketTransport(options.url, {
		protocols: options.protocols,
		WebSocket: options.WebSocket,
	});
	const app = new WebFrontendApp({ ...options, client: new WebClient(transport) });
	try {
		await app.start();
		return app;
	} catch (cause) {
		app.dispose();
		throw cause;
	}
}

export type WebFrontendAction = WebAction;
