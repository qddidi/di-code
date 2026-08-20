import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { InteractiveController } from "../src/interactive/controller.ts";
import {
	createWebAuthorization,
	parseWebClientMessage,
	WebFrontendHost,
	type WebServerMessage,
	type WebTransport,
} from "../src/web.ts";

class FakeTransport implements WebTransport {
	readonly sent: WebServerMessage[] = [];
	private readonly messageListeners = new Set<(message: string) => void>();
	private readonly closeListeners = new Set<() => void>();
	send(message: string): void {
		this.sent.push(JSON.parse(message) as WebServerMessage);
	}
	onMessage(listener: (message: string) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}
	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}
	close(): void {
		for (const listener of this.closeListeners) listener();
	}
	push(message: unknown): void {
		const text = JSON.stringify(message);
		for (const listener of this.messageListeners) listener(text);
	}
}

const controllers: InteractiveController[] = [];
afterEach(() => {
	for (const controller of controllers) controller.dispose();
	controllers.length = 0;
});

function createHost(responses: Parameters<typeof createFauxProvider>[0]["responses"] = []) {
	const faux = createFauxProvider({ responses });
	const controller = new InteractiveController({
		session: new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model }),
	});
	controllers.push(controller);
	return new WebFrontendHost({
		controller,
		authorization: createWebAuthorization({ token: "browser-token", allowedFrontendIds: ["web"], allowedSlotIds: [] }),
	});
}

describe("WebFrontendHost", () => {
	it("validates browser authorization and exposes only a projected state", () => {
		const host = createHost();
		const transport = new FakeTransport();
		host.attach(transport);
		transport.push({ version: 1, kind: "connect", requestId: "connect-1", token: "wrong", frontendId: "web" });
		expect(transport.sent.at(-1)).toMatchObject({ kind: "error", code: "UNAUTHORIZED" });
		transport.push({ version: 1, kind: "connect", requestId: "connect-2", token: "browser-token", frontendId: "web" });
		expect(transport.sent.at(-1)).toMatchObject({ kind: "hello", sessionId: expect.any(String) });
	});

	it("keeps the host alive across reconnect and replays only newer events", async () => {
		const host = createHost([{ type: "success", content: [{ type: "text", text: "answer" }] }]);
		const first = new FakeTransport();
		host.attach(first);
		first.push({ version: 1, kind: "connect", requestId: "connect-1", token: "browser-token", frontendId: "web" });
		first.push({ version: 1, kind: "action", requestId: "action-1", action: { type: "submit", input: "hello" } });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const latest = host.latestEventId;
		first.close();
		const second = new FakeTransport();
		host.attach(second);
		second.push({
			version: 1,
			kind: "connect",
			requestId: "connect-2",
			token: "browser-token",
			frontendId: "web",
			lastEventId: 0,
		});
		expect(second.sent).toContainEqual(expect.objectContaining({ kind: "hello", replayedFrom: 0 }));
		expect(
			second.sent.filter((message) => message.kind === "event").every((message) => (message.eventId ?? 0) <= latest),
		).toBe(true);
		host.dispose();
	});

	it("rejects unauthorized slot actions and expired authorizations", () => {
		expect(() =>
			parseWebClientMessage(
				JSON.stringify({ version: 1, kind: "action", requestId: "x", action: { type: "cancel" }, baseEventId: -1 }),
			),
		).toThrow();
		const faux = createFauxProvider({ responses: [] });
		const controller = new InteractiveController({
			session: new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model }),
		});
		controllers.push(controller);
		const host = new WebFrontendHost({
			controller,
			now: () => 10,
			authorization: createWebAuthorization({
				token: "token",
				allowedFrontendIds: ["web"],
				allowedSlotIds: ["slot"],
				expiresAt: 10,
			}),
		});
		const transport = new FakeTransport();
		host.attach(transport);
		transport.push({ version: 1, kind: "connect", requestId: "connect", token: "token", frontendId: "web" });
		expect(transport.sent.at(-1)).toMatchObject({ kind: "error", code: "EXPIRED" });
	});

	it("rejects actions based on events that fell out of the replay window", async () => {
		const faux = createFauxProvider({
			responses: [
				{ type: "success", content: [{ type: "text", text: "one" }] },
				{ type: "success", content: [{ type: "text", text: "two" }] },
			],
		});
		const controller = new InteractiveController({
			session: new AgentSession({ allowedRoot: process.cwd(), provider: faux.provider, model: faux.model }),
		});
		controllers.push(controller);
		const host = new WebFrontendHost({
			controller,
			replayLimit: 1,
			authorization: createWebAuthorization({ token: "token", allowedFrontendIds: ["web"] }),
		});
		const transport = new FakeTransport();
		host.attach(transport);
		transport.push({ version: 1, kind: "connect", requestId: "connect", token: "token", frontendId: "web" });
		transport.push({ version: 1, kind: "action", requestId: "one", action: { type: "submit", input: "one" } });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		transport.push({ version: 1, kind: "action", requestId: "two", action: { type: "submit", input: "two" } });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		transport.push({ version: 1, kind: "action", requestId: "stale", baseEventId: 0, action: { type: "cancel" } });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(transport.sent.at(-1)).toMatchObject({ kind: "error", code: "STALE_EVENT" });
	});
});
