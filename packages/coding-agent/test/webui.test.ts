import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import {
	agentSession,
	compactionBasic,
	compactionToolResult,
	contextBudget,
	networkCapability,
	processCapability,
	providerRegistry,
	resourceLoader,
	sessionMigrations,
	sessionStoreJsonl,
	skills,
	systemPrompt,
	toolApproval,
	toolOutput,
	toolPolicy,
	toolRegistry,
	usageMeter,
	workspace,
} from "@di-code/builtins";
import { createRootContext } from "@di-code/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import * as interactiveResources from "../src/interactive-resources-entry.ts";
import { mcpClient, mcpConfig, mcpTools, mcpTransport } from "../src/mcp/entries.ts";
import { installAgentSessionFactory } from "../src/runtime/session-factory.ts";
import * as productSessionStoreJsonl from "../src/session-store-jsonl-entry.ts";
import { WebUiServer } from "../src/webui.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createServer(): Promise<{
	readonly server: WebUiServer;
	readonly baseUrl: string;
	readonly token: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "di-code-webui-root-"));
	const agentDir = await mkdtemp(join(tmpdir(), "di-code-webui-agent-"));
	const faux = createFauxProvider({
		responses: [{ type: "success", content: [{ type: "text", text: "web answer" }] }],
	});
	const context = createRootContext({ id: "webui-test", mode: "test", trustedProject: true });
	for (const definition of [providerRegistry, toolRegistry]) await context.plugin(definition, undefined);
	await context.plugin(workspace, { allowedRoot: root });
	for (const definition of [
		processCapability,
		networkCapability,
		toolApproval,
		toolPolicy,
		toolOutput,
		contextBudget,
		compactionBasic,
		compactionToolResult,
		systemPrompt,
		resourceLoader,
		skills,
		usageMeter,
		agentSession,
		sessionStoreJsonl,
		sessionMigrations,
	])
		await context.plugin(definition, undefined);
	await context.plugin(productSessionStoreJsonl, undefined);
	await context.plugin(interactiveResources, undefined);
	await context.plugin(mcpConfig, undefined);
	await context.plugin(mcpTransport, undefined);
	await context.plugin(mcpClient, undefined);
	await context.plugin(mcpTools, undefined);
	const removeFactory = installAgentSessionFactory(context);
	const server = new WebUiServer({
		context,
		allowedRoot: root,
		agentDir,
		provider: faux.provider,
		model: faux.model,
		token: "test-webui-token-which-is-at-least-32-characters",
		projectTrusted: true,
		rateLimit: { windowMs: 1_000, maxRequests: 100 },
	});
	const address = await server.listen();
	cleanups.push(async () => {
		await server.close();
		await removeFactory();
		await context.dispose();
		await rm(root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});
	return {
		server,
		baseUrl: `http://${address.host}:${address.port}`,
		token: "test-webui-token-which-is-at-least-32-characters",
	};
}

function headers(token: string, clientId?: string): Headers {
	const result = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
	if (clientId) result.set("x-di-code-client-id", clientId);
	return result;
}

describe("WebUiServer", () => {
	it("routes HTTP RPC through isolated SessionHost actors without exposing local paths", async () => {
		const { baseUrl, token } = await createServer();
		const first = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "first",
				method: "prompt",
				params: { message: "hello" },
			}),
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			ok: true,
			result: { method: "prompt", message: { content: [{ text: "web answer" }] } },
		});
		const firstClient = first.headers.get("x-di-code-client-id");
		expect(firstClient).toBeTruthy();
		const second = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, "second-client-identifier"),
			body: JSON.stringify({ version: 1, kind: "request", id: "second", method: "get_state", params: {} }),
		});
		expect(await second.json()).toMatchObject({ ok: true, result: { state: { messageCount: 0 } } });
		const denied = await fetch(`${baseUrl}/rpc?workspace=C:\\`, {
			method: "POST",
			headers: headers(token, firstClient ?? undefined),
			body: JSON.stringify({ version: 1, kind: "request", id: "denied", method: "get_state", params: {} }),
		});
		expect(denied.status).toBe(400);
		expect(await denied.text()).not.toContain(rootPath(baseUrl));
	});

	it("enforces token and Origin checks, accepts bounded image attachments, and provides SSE resume credentials", async () => {
		const { baseUrl, token } = await createServer();
		await expect(fetch(`${baseUrl}/rpc`, { method: "POST", body: "{}" })).resolves.toMatchObject({ status: 401 });
		const untrustedHeaders = headers(token);
		untrustedHeaders.set("origin", "https://untrusted.example");
		await expect(
			fetch(`${baseUrl}/rpc`, {
				method: "POST",
				headers: untrustedHeaders,
				body: "{}",
			}),
		).resolves.toMatchObject({ status: 403 });
		const uploaded = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: headers(token, "attachment-client-id"),
			body: JSON.stringify({ name: "image.png", contentType: "image/png", data: "iVBORw0KGgo=" }),
		});
		expect(await uploaded.json()).toMatchObject({
			ok: true,
			result: { method: "create_attachment", attachment: { id: expect.any(String) } },
		});
		const events = await fetch(`${baseUrl}/events`, { headers: headers(token, "attachment-client-id") });
		expect(events.status).toBe(200);
		const reader = events.body?.getReader();
		const firstChunk = await reader?.read();
		const text = new TextDecoder().decode(firstChunk?.value);
		expect(text).toContain("resumeToken");
		const resumeToken = JSON.parse((text.match(/data: (.+)/)?.[1] ?? "{}") as string).resumeToken as string;
		await reader?.cancel();
		const resumedHeaders = headers(token);
		resumedHeaders.set("x-di-code-resume-token", resumeToken);
		resumedHeaders.set("last-event-id", "0");
		const resumed = await fetch(`${baseUrl}/events`, {
			headers: resumedHeaders,
		});
		expect(resumed.headers.get("x-di-code-client-id")).toBe("attachment-client-id");
		await resumed.body?.cancel();
	});
});

function rootPath(_baseUrl: string): string {
	return "di-code-webui-root-";
}
