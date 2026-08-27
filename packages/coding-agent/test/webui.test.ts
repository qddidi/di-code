import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createFauxProvider } from "@di-code/ai";
import {
	agentSession,
	bootstrap,
	commandCompact,
	commandCore,
	commandInteractiveCore,
	commandModel,
	commandRegistryKey,
	commandSession,
	commandSettings,
	compactionBasic,
	compactionToolResult,
	contextBudget,
	modelCatalog,
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

async function createServer(overrides: Partial<ConstructorParameters<typeof WebUiServer>[0]> = {}): Promise<{
	readonly server: WebUiServer;
	readonly baseUrl: string;
	readonly token: string;
	readonly agentDir: string;
	readonly root: string;
	readonly context: ReturnType<typeof createRootContext>;
}> {
	const root = await mkdtemp(join(tmpdir(), "di-code-webui-root-"));
	const agentDir = await mkdtemp(join(tmpdir(), "di-code-webui-agent-"));
	const faux = createFauxProvider({
		responses: [{ type: "success", content: [{ type: "text", text: "web answer" }] }],
	});
	const context = createRootContext({ id: "webui-test", mode: "test", trustedProject: true });
	await context.plugin(bootstrap, undefined);
	await context.plugin(commandCore, undefined);
	for (const definition of [commandSession, commandModel, commandSettings, commandCompact, commandInteractiveCore])
		await context.plugin(definition, undefined);
	for (const definition of [providerRegistry, toolRegistry]) await context.plugin(definition, undefined);
	await context.plugin(modelCatalog, undefined);
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
		...overrides,
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
		agentDir,
		root,
		context,
	};
}

function headers(token: string, clientId?: string): Headers {
	const result = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
	if (clientId) result.set("x-di-code-client-id", clientId);
	return result;
}

describe("WebUiServer", () => {
	it("projects built-in and custom commands through the HTTP RPC transport", async () => {
		const { baseUrl, context, token } = await createServer();
		let customArgs: string | undefined;
		context.require(commandRegistryKey).register({
			name: "custom-check",
			description: "Run a custom check",
			run: (input) => {
				customArgs = (input as { readonly args: string }).args;
				return 0;
			},
		});
		const clientId = "command-http-client";
		const listed = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ version: 1, kind: "request", id: "command-list", method: "list_commands", params: {} }),
		});
		expect(listed.status).toBe(200);
		const listedResult = (await listed.json()) as {
			readonly ok: boolean;
			readonly result: { readonly method: string; readonly commands: readonly { readonly name: string }[] };
		};
		expect(listedResult).toMatchObject({
			ok: true,
			result: { method: "list_commands" },
		});
		expect(listedResult.result.commands.map((command) => command.name)).toEqual(
			expect.arrayContaining(["help", "compact", "custom-check"]),
		);
		const builtin = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "command-help",
				method: "run_command",
				params: { name: "help", args: "" },
			}),
		});
		expect(builtin.status).toBe(200);
		expect(await builtin.json()).toMatchObject({
			ok: true,
			result: { method: "run_command", command: "help", action: { command: "help", args: "" } },
		});
		const custom = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "command-custom",
				method: "run_command",
				params: { name: "custom-check", args: "from web" },
			}),
		});
		expect(custom.status).toBe(200);
		expect(await custom.json()).toMatchObject({ ok: true, result: { method: "run_command", command: "custom-check" } });
		expect(customArgs).toBe("from web");
	});

	it("returns and navigates the active Session tree through WebUI RPC", async () => {
		const { baseUrl, token } = await createServer();
		const clientId = "tree-http-client";
		const prompted = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "tree-prompt",
				method: "prompt",
				params: { message: "return to this request" },
			}),
		});
		expect(prompted.status).toBe(200);
		const listed = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ version: 1, kind: "request", id: "tree-list", method: "get_tree", params: {} }),
		});
		expect(listed.status).toBe(200);
		const tree = (await listed.json()) as {
			readonly result: { readonly tree: readonly { readonly entry: { readonly id: string } }[] };
		};
		const entryId = tree.result.tree[0]?.entry.id;
		expect(entryId).toBeTruthy();
		const navigated = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "tree-navigate",
				method: "navigate_tree",
				params: { entryId },
			}),
		});
		expect(navigated.status).toBe(200);
		expect(await navigated.json()).toMatchObject({
			ok: true,
			result: {
				method: "navigate_tree",
				navigation: { selectedEntryId: entryId, editorText: "return to this request" },
			},
		});
	});

	it("serves a same-origin SPA with isolated API, boot data, and health checks", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-webui-static-"));
		await writeFile(join(root, "index.html"), "<main>di-code web</main>", "utf8");
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "assets", "app-123.js"), "export {}", "utf8");
		const developmentOrigin = "http://127.0.0.1:4111";
		const { baseUrl, token } = await createServer({ staticRoot: root, developmentOrigin });
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const page = await fetch(`${baseUrl}/workspace/session`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("di-code web");
		expect(page.headers.get("cache-control")).toBe("no-cache");
		const asset = await fetch(`${baseUrl}/assets/app-123.js`);
		expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		const cookie = page.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		const boot = await fetch(`${baseUrl}/api/boot`, { headers: { cookie: cookie?.split(";")[0] ?? "" } });
		expect(boot.status).toBe(200);
		const bootData = (await boot.json()) as {
			readonly workspaceId: string;
			readonly workspaces: readonly { readonly id: string }[];
		};
		expect(bootData).toMatchObject({ workspaceId: expect.any(String), workspaces: [{ id: expect.any(String) }] });
		expect(bootData.workspaces[0]?.id).toBe(bootData.workspaceId);
		await expect(fetch(`${baseUrl}/api/rpc`, { method: "POST", body: "{}" })).resolves.toMatchObject({ status: 401 });
		const developmentSession = await fetch(`${baseUrl}/api/session`, { headers: { origin: developmentOrigin } });
		expect(developmentSession.status).toBe(204);
		expect(developmentSession.headers.get("set-cookie")).toContain("HttpOnly");
		await expect(fetch(`${baseUrl}/healthz`)).resolves.toMatchObject({ status: 200 });
		await expect(fetch(`${baseUrl}/%2e%2e%2fsettings.json`)).resolves.toMatchObject({ status: 403 });
		const legacy = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ version: 1, kind: "request", id: "legacy", method: "get_state", params: {} }),
		});
		expect(legacy.status).toBe(200);
	});

	it("routes HTTP RPC through isolated SessionHost actors without exposing local paths", async () => {
		const { baseUrl, token, agentDir } = await createServer();
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
		expect(
			(await readdir(join(agentDir, "sessions"), { recursive: true })).some((file) => file.endsWith(".jsonl")),
		).toBe(true);
		const clientTempFiles = await readdir(join(agentDir, "webui", "actors"), { recursive: true });
		expect(clientTempFiles.some((file) => file === "settings.json" || file.startsWith("sessions"))).toBe(false);
		const firstClient = first.headers.get("x-di-code-client-id");
		expect(firstClient).toBeTruthy();
		const providers = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, firstClient ?? undefined),
			body: JSON.stringify({ version: 1, kind: "request", id: "providers", method: "list_providers", params: {} }),
		});
		expect(await providers.json()).toMatchObject({
			ok: true,
			result: {
				method: "list_providers",
				providers: expect.arrayContaining([expect.objectContaining({ id: "faux" })]),
			},
		});
		const trust = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, firstClient ?? undefined),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "trust",
				method: "set_project_trust",
				params: { trusted: false },
			}),
		});
		expect(await trust.json()).toMatchObject({ ok: true, result: { method: "set_project_trust", trusted: false } });
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

	it("persists and returns generated assistant images through the WebUI RPC", async () => {
		const generated = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }],
		});
		const { baseUrl, token } = await createServer({ provider: generated.provider, model: generated.model });
		const clientId = "generated-image-client";
		const prompt = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "generated-image",
				method: "prompt",
				params: { message: "generate an image" },
			}),
		});
		expect(prompt.status).toBe(200);
		expect(await prompt.json()).toMatchObject({
			ok: true,
			result: {
				method: "prompt",
				message: { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] },
			},
		});
		const transcript = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "generated-image-transcript",
				method: "get_transcript",
				params: {},
			}),
		});
		expect(await transcript.json()).toMatchObject({
			ok: true,
			result: {
				method: "get_transcript",
				transcript: expect.arrayContaining([
					expect.objectContaining({ role: "assistant", content: [expect.objectContaining({ type: "image" })] }),
				]),
			},
		});
	});

	it("adds a validated workspace through the authenticated WebUI route", async () => {
		const { baseUrl, token } = await createServer();
		const addedRoot = await mkdtemp(join(tmpdir(), "di-code-webui-added-"));
		cleanups.push(() => rm(addedRoot, { recursive: true, force: true }));
		const added = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ path: addedRoot }),
		});
		expect(added.status).toBe(200);
		const result = (await added.json()) as { readonly workspace: { readonly id: string; readonly name: string } };
		expect(result.workspace.name).toBeTruthy();
		const boot = await fetch(`${baseUrl}/api/boot`, { headers: headers(token) });
		expect(boot.status).toBe(200);
		expect((await boot.json()) as { readonly workspaces: readonly { readonly id: string }[] }).toMatchObject({
			workspaces: expect.arrayContaining([expect.objectContaining({ id: result.workspace.id })]),
		});
		const invalid = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ path: join(addedRoot, "missing") }),
		});
		expect(invalid.status).toBe(400);
	});

	it("returns a safe Provider failure for WebUI clients to render and retry", async () => {
		const faux = createFauxProvider({
			responses: [{ type: "failure", errorMessage: "Provider rejected the credential" }],
		});
		const { baseUrl, token } = await createServer({ provider: faux.provider, model: faux.model });
		const response = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "provider-failure",
				method: "prompt",
				params: { message: "hello" },
			}),
		});

		expect(await response.json()).toMatchObject({
			ok: true,
			result: {
				method: "prompt",
				message: { stopReason: "error", errorMessage: "Provider rejected the credential", content: [] },
			},
		});
	});

	it("reports each model's supported reasoning efforts in the settings snapshot", async () => {
		const faux = createFauxProvider({ responses: [] });
		const model = {
			...faux.model,
			id: "glm-5.3",
			name: "GLM-5.3",
			provider: "zhipu",
			reasoning: true,
			reasoningEfforts: ["low", "high", "max"] as const,
			defaultReasoningEffort: "max" as const,
		};
		const provider = { ...faux.provider, id: "zhipu", name: "Zhipu", models: [model] };
		const { baseUrl, token } = await createServer({ provider, model });
		const response = await fetch(`${baseUrl}/rpc`, {
			headers: headers(token),
			method: "POST",
			body: JSON.stringify({ version: 1, kind: "request", id: "settings", method: "get_settings", params: {} }),
		});

		expect(await response.json()).toMatchObject({
			ok: true,
			result: {
				method: "get_settings",
				settings: {
					providers: expect.arrayContaining([
						expect.objectContaining({
							id: "zhipu",
							models: expect.arrayContaining([
								expect.objectContaining({ id: "glm-5.3", reasoningEfforts: ["low", "high", "max"] }),
							]),
						}),
					]),
				},
			},
		});
	});

	it("keeps Zhipu available for Web login when the initial runtime falls back to Faux", async () => {
		const { baseUrl, token } = await createServer();
		const settings = await fetch(`${baseUrl}/rpc`, {
			headers: headers(token),
			method: "POST",
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "fallback-settings",
				method: "get_settings",
				params: {},
			}),
		});
		expect(await settings.json()).toMatchObject({
			ok: true,
			result: {
				settings: {
					providers: expect.arrayContaining([
						expect.objectContaining({ id: "zhipu", configured: false, models: expect.any(Array) }),
					]),
				},
			},
		});
		const login = await fetch(`${baseUrl}/rpc`, {
			headers: headers(token),
			method: "POST",
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "fallback-zhipu-login",
				method: "login",
				params: { providerId: "zhipu", modelId: "glm-5.3", apiKey: "test-zhipu-key" },
			}),
		});
		expect(await login.json()).toMatchObject({ ok: true, result: { method: "login", provider: { id: "zhipu" } } });
	});

	it("activates Zhipu after Web login when startup explicitly selects it without a key", async () => {
		const previousProvider = process.env.DI_CODE_PROVIDER;
		const previousApiKey = process.env.ZAI_API_KEY;
		process.env.DI_CODE_PROVIDER = "zhipu";
		delete process.env.ZAI_API_KEY;
		try {
			const { baseUrl, token } = await createServer();
			const response = await fetch(`${baseUrl}/rpc`, {
				headers: headers(token),
				method: "POST",
				body: JSON.stringify({
					version: 1,
					kind: "request",
					id: "explicit-zhipu-login",
					method: "login",
					params: { providerId: "zhipu", modelId: "glm-5.3", apiKey: "test-zhipu-key" },
				}),
			});
			expect(await response.json()).toMatchObject({ ok: true, result: { method: "login", provider: { id: "zhipu" } } });
		} finally {
			if (previousProvider === undefined) delete process.env.DI_CODE_PROVIDER;
			else process.env.DI_CODE_PROVIDER = previousProvider;
			if (previousApiKey === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = previousApiKey;
		}
	});

	it("saves a Zhipu key when an incomplete Zhipu entry already exists", async () => {
		const { agentDir, baseUrl, token } = await createServer();
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				providers: { zhipu: { api: "openai-chat-completions" } },
				defaultProvider: "zhipu",
				defaultModel: "glm-5.3",
			}),
			"utf8",
		);
		const response = await fetch(`${baseUrl}/rpc`, {
			headers: headers(token),
			method: "POST",
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "incomplete-zhipu-login",
				method: "login",
				params: { providerId: "zhipu", modelId: "glm-5.3", apiKey: "test-zhipu-key" },
			}),
		});
		expect(await response.json()).toMatchObject({ ok: true, result: { method: "login", provider: { id: "zhipu" } } });
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			providers: { zhipu: { apiKey: "test-zhipu-key" } },
		});
	});

	it("falls back to Faux after logout leaves several configured Providers without a default", async () => {
		const { agentDir, baseUrl, token } = await createServer();
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				providers: {
					openai: { api: "openai-responses", apiKey: "test-openai-key" },
					deepseek: { api: "openai-chat-completions", apiKey: "test-deepseek-key" },
				},
			}),
			"utf8",
		);
		const response = await fetch(`${baseUrl}/rpc`, {
			headers: headers(token),
			method: "POST",
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "logout-without-default",
				method: "logout",
				params: { providerId: "deepseek" },
			}),
		});
		expect(await response.json()).toMatchObject({ ok: true, result: { method: "logout" } });
		const runtime = await fetch(`${baseUrl}/rpc`, {
			headers: headers(token),
			method: "POST",
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "runtime-after-logout",
				method: "get_runtime",
				params: {},
			}),
		});
		expect(await runtime.json()).toMatchObject({ ok: true, result: { providerId: "faux", modelId: "faux-model" } });
	});

	it("persists a WebUI runtime change for new Sessions and terminal startup", async () => {
		const { baseUrl, token, agentDir } = await createServer();
		const change = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "runtime-change",
				method: "set_runtime",
				params: { providerId: "faux", modelId: "faux-model" },
			}),
		});
		expect(change.status).toBe(200);
		expect(await change.json()).toMatchObject({ ok: true, result: { method: "set_runtime" } });
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: "faux",
			defaultModel: "faux-model",
		});
		const settings = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ version: 1, kind: "request", id: "runtime-settings", method: "get_settings", params: {} }),
		});
		expect(await settings.json()).toMatchObject({
			ok: true,
			result: { settings: { defaults: { providerId: "faux", modelId: "faux-model" } } },
		});
	});

	it("applies a configured Custom provider to the active WebUI Session", async () => {
		const { baseUrl, token } = await createServer();
		const configure = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "configure-custom",
				method: "configure_custom_provider",
				params: {
					api: "openai-chat-completions",
					baseUrl: "https://custom.example/v1",
					apiKey: "test-custom-key",
					modelId: "custom-model",
				},
			}),
		});
		expect(await configure.json()).toMatchObject({
			ok: true,
			result: { method: "configure_custom_provider", provider: { id: "custom", models: [{ id: "custom-model" }] } },
		});
		const change = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "use-custom",
				method: "set_runtime",
				params: { providerId: "custom", modelId: "custom-model" },
			}),
		});
		expect(await change.json()).toMatchObject({
			ok: true,
			result: { method: "set_runtime", model: { id: "custom-model", provider: "custom" } },
		});
		const runtime = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ version: 1, kind: "request", id: "custom-runtime", method: "get_runtime", params: {} }),
		});
		expect(await runtime.json()).toMatchObject({
			ok: true,
			result: { method: "get_runtime", providerId: "custom", modelId: "custom-model" },
		});
	});

	it("starts a new WebUI actor with the persisted model preference", async () => {
		const faux = createFauxProvider({ responses: [] });
		const alternate = { ...faux.model, id: "faux-alternate", name: "Faux alternate" };
		const provider = { ...faux.provider, models: [faux.model, alternate] };
		const { baseUrl, token } = await createServer({ provider, model: faux.model });
		const firstClient = "runtime-preference-first";
		const secondClient = "runtime-preference-second";
		const change = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, firstClient),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "alternate-runtime",
				method: "set_runtime",
				params: { providerId: "faux", modelId: "faux-alternate" },
			}),
		});
		expect(await change.json()).toMatchObject({ ok: true, result: { method: "set_runtime" } });
		const settings = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, secondClient),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "new-actor-settings",
				method: "get_settings",
				params: {},
			}),
		});
		expect(await settings.json()).toMatchObject({
			ok: true,
			result: { settings: { runtime: { providerId: "faux", modelId: "faux-alternate" } } },
		});
	});

	it("persists a WebUI thinking-level change for the selected model", async () => {
		const faux = createFauxProvider({ responses: [] });
		const model = {
			...faux.model,
			reasoning: true,
			reasoningEfforts: ["low", "high"] as const,
			defaultReasoningEffort: "low" as const,
		};
		const provider = { ...faux.provider, models: [model] };
		const { baseUrl, token, agentDir } = await createServer({ provider, model });
		const change = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "thinking-change",
				method: "set_thinking_level",
				params: { level: "high" },
			}),
		});
		expect(change.status).toBe(200);
		expect(await change.json()).toMatchObject({ ok: true, result: { method: "set_thinking_level", level: "high" } });
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			thinkingLevels: { faux: { "faux-model": "high" } },
		});
	});

	it("persists WebUI runtime preferences in existing workspace settings", async () => {
		const faux = createFauxProvider({ responses: [] });
		const model = {
			...faux.model,
			reasoning: true,
			reasoningEfforts: ["low", "high"] as const,
			defaultReasoningEffort: "low" as const,
		};
		const provider = { ...faux.provider, models: [model] };
		const { baseUrl, token, agentDir, root } = await createServer({ provider, model });
		await mkdir(join(root, ".di-code"));
		await writeFile(join(root, ".di-code", "settings.json"), JSON.stringify({ providers: {} }));

		const runtime = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "workspace-runtime-change",
				method: "set_runtime",
				params: { providerId: "faux", modelId: "faux-model" },
			}),
		});
		expect(await runtime.json()).toMatchObject({ ok: true, result: { method: "set_runtime" } });
		const thinking = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "workspace-thinking-change",
				method: "set_thinking_level",
				params: { level: "high" },
			}),
		});
		expect(await thinking.json()).toMatchObject({ ok: true, result: { method: "set_thinking_level", level: "high" } });
		expect(JSON.parse(await readFile(join(root, ".di-code", "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: "faux",
			defaultModel: "faux-model",
			thinkingLevels: { faux: { "faux-model": "high" } },
		});
		await expect(readFile(join(agentDir, "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
		const fiveMiB = Buffer.alloc(5 * 1024 * 1024, 1).toString("base64");
		const maximum = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: headers(token, "attachment-client-id"),
			body: JSON.stringify({ name: "maximum.png", contentType: "image/png", data: fiveMiB }),
		});
		const maximumResult = await maximum.json();
		expect(maximumResult).toMatchObject({ ok: true, result: { method: "create_attachment" } });
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

	it("passes an uploaded image through the WebUI actor into the Provider context", async () => {
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "seen" }] }] });
		const contexts: Context[] = [];
		const provider = {
			...faux.provider,
			stream: (model: typeof faux.model, context: Context, options?: Parameters<typeof faux.provider.stream>[2]) => {
				contexts.push(structuredClone(context));
				return faux.provider.stream(model, context, options);
			},
		};
		const { baseUrl, token } = await createServer({ provider, model: faux.model });
		const clientId = "image-context-client";
		const upload = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ name: "image.png", contentType: "image/png", data: "AQI=" }),
		});
		const attachment = (await upload.json()) as { readonly result: { readonly attachment: { readonly id: string } } };
		const prompt = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "image-context-prompt",
				method: "prompt",
				params: { message: "describe", attachmentIds: [attachment.result.attachment.id] },
			}),
		});
		expect(await prompt.json()).toMatchObject({ ok: true, result: { method: "prompt" } });
		expect(contexts.at(-1)?.messages.at(-1)).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "describe" },
				{ type: "image", mimeType: "image/png", data: "AQI=" },
			],
		});
		const transcript = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "image-context-transcript",
				method: "get_transcript",
				params: { maxBytes: 8 * 1024 * 1024 },
			}),
		});
		const transcriptResult = (await transcript.json()) as {
			readonly ok: boolean;
			readonly result: { readonly method: string; readonly transcript: readonly unknown[] };
		};
		expect(transcriptResult).toMatchObject({ ok: true, result: { method: "get_transcript" } });
		const persistedImageMessage = transcriptResult.result.transcript.find((entry) => {
			if (typeof entry !== "object" || entry === null) return false;
			const record = entry as Record<string, unknown>;
			if (record.role !== "user" || !Array.isArray(record.content)) return false;
			return (
				record.content.some((block) => {
					if (typeof block !== "object" || block === null) return false;
					const content = block as Record<string, unknown>;
					return content.type === "text" && content.text === "describe";
				}) &&
				record.content.some((block) => {
					if (typeof block !== "object" || block === null) return false;
					const content = block as Record<string, unknown>;
					return content.type === "image" && content.mimeType === "image/png" && content.data === "AQI=";
				})
			);
		});
		expect(persistedImageMessage).toBeDefined();
	});

	it("keeps detached request state idempotent and removes actor attachments on use and shutdown", async () => {
		const { baseUrl, token, server, agentDir } = await createServer();
		const clientId = "lifecycle-client-id";
		const events = await fetch(`${baseUrl}/events`, { headers: headers(token, clientId) });
		const reader = events.body?.getReader();
		await reader?.read();
		const attachment = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ name: "image.png", contentType: "image/png", data: "aGVsbG8=" }),
		});
		const attachmentValue = (await attachment.json()) as {
			readonly result: { readonly attachment: { readonly id: string } };
		};
		const promptRequest = {
			version: 1,
			kind: "request",
			id: "same-request",
			method: "prompt",
			params: { message: "describe", attachmentIds: [attachmentValue.result.attachment.id] },
		};
		const first = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify(promptRequest),
		});
		const duplicate = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ ...promptRequest, params: { message: "different" } }),
		});
		expect(await duplicate.json()).toEqual(await first.json());
		let streamEvents = "";
		for (
			let index = 0;
			index < 4 && (!streamEvents.includes('"type":"agent_start"') || !streamEvents.includes('"type":"agent_end"'));
			index++
		) {
			const chunk = await reader?.read();
			if (!chunk || chunk.done) break;
			streamEvents += new TextDecoder().decode(chunk.value);
		}
		expect(streamEvents).toContain('"type":"agent_start"');
		expect(streamEvents).toContain('"type":"agent_end"');
		await reader?.cancel();
		const operation = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({
				version: 1,
				kind: "request",
				id: "operation-state",
				method: "get_operation",
				params: { requestId: "same-request" },
			}),
		});
		expect(operation.status).toBe(200);
		const newSession = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ version: 1, kind: "request", id: "new-session", method: "new_session", params: {} }),
		});
		expect(await newSession.json()).toMatchObject({ ok: true, result: { method: "new_session" } });
		const state = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: headers(token, clientId),
			body: JSON.stringify({ version: 1, kind: "request", id: "new-state", method: "get_state", params: {} }),
		});
		expect(await state.json()).toMatchObject({ ok: true, result: { state: { messageCount: 0 } } });
		const storedFiles = await readdir(join(agentDir, "webui"), { recursive: true });
		expect(storedFiles.some((file) => file.endsWith(".attachment"))).toBe(false);
		await server.close();
		expect((await readdir(agentDir, { recursive: true })).some((file) => file.endsWith(".attachment"))).toBe(false);
	});

	it("expires and rotates resume credentials and enforces per-client SSE limits", async () => {
		const { baseUrl, token } = await createServer({ resumeTokenTtlMs: 20, maxSseConnectionsPerClient: 1 });
		const first = await fetch(`${baseUrl}/events`, { headers: headers(token, "resume-client-id") });
		const reader = first.body?.getReader();
		const initial = new TextDecoder().decode((await reader?.read())?.value);
		const resumeToken = JSON.parse(initial.match(/data: (.+)/)?.[1] ?? "{}").resumeToken as string;
		await expect(fetch(`${baseUrl}/events`, { headers: headers(token, "resume-client-id") })).resolves.toMatchObject({
			status: 429,
		});
		await reader?.cancel();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const expired = headers(token);
		expired.set("x-di-code-resume-token", resumeToken);
		await expect(fetch(`${baseUrl}/events`, { headers: expired })).resolves.toMatchObject({ status: 401 });

		const second = await fetch(`${baseUrl}/events`, { headers: headers(token, "rotation-client-id") });
		const secondReader = second.body?.getReader();
		const secondInitial = new TextDecoder().decode((await secondReader?.read())?.value);
		const secondToken = JSON.parse(secondInitial.match(/data: (.+)/)?.[1] ?? "{}").resumeToken as string;
		await secondReader?.cancel();
		const resumedHeaders = headers(token);
		resumedHeaders.set("x-di-code-resume-token", secondToken);
		const resumed = await fetch(`${baseUrl}/events`, { headers: resumedHeaders });
		expect(resumed.status).toBe(200);
		const resumedReader = resumed.body?.getReader();
		const rotatedInitial = new TextDecoder().decode((await resumedReader?.read())?.value);
		const rotatedToken = JSON.parse(rotatedInitial.match(/data: (.+)/)?.[1] ?? "{}").resumeToken as string;
		expect(rotatedToken).not.toBe(secondToken);
		const oldToken = headers(token);
		oldToken.set("x-di-code-resume-token", secondToken);
		await expect(fetch(`${baseUrl}/events`, { headers: oldToken })).resolves.toMatchObject({ status: 401 });
		await resumedReader?.cancel();
	});
});

function rootPath(_baseUrl: string): string {
	return "di-code-webui-root-";
}
