import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { commandRegistryKey, type ToolApprovalCapability } from "@di-code/builtins";
import type { Context } from "@di-code/plugin-runtime";
import { createProjectTrustStore } from "./project-trust-entry.ts";
import { RpcDispatcher } from "./rpc/dispatcher.ts";
import { parseRpcRequest, RPC_PROTOCOL_VERSION, type RpcRequest, type RpcServerMessage } from "./rpc/protocol.ts";
import { createManagedAttachmentStore } from "./runtime/attachment-store.ts";
import { createProductHost, type ProductHost } from "./runtime/product-host.ts";
import { HostManager, type SessionActor, type SessionHostBootstrapOptions } from "./runtime/session-host.ts";
import {
	loadStartupConfiguration,
	resolveStartupRuntime,
	type StartupConfiguration,
	type StartupRuntime,
} from "./startup.ts";

export interface WebUiServerOptions extends Omit<SessionHostBootstrapOptions, "cwd" | "principal" | "toolApproval"> {
	readonly context: Context;
	readonly allowedRoot: string;
	/** User-level directory shared by WebUI restarts for workspace registrations. */
	readonly workspaceRegistryDir?: string;
	/** Additional workspace roots explicitly authorized by the launcher. */
	readonly allowedWorkspaces?: readonly string[];
	readonly host?: string;
	readonly port?: number;
	readonly token?: string;
	readonly allowRemote?: boolean;
	readonly origins?: readonly string[];
	readonly maxBodyBytes?: number;
	readonly rateLimit?: { readonly windowMs: number; readonly maxRequests: number };
	/** Maximum simultaneous SSE subscriptions for one authenticated client. */
	readonly maxSseConnectionsPerClient?: number;
	/** Maximum simultaneous SSE subscriptions across the server. */
	readonly maxSseConnections?: number;
	/** Lifetime of a reconnect credential; defaults to ten minutes. */
	readonly resumeTokenTtlMs?: number;
	/** Optional SPA asset directory. API routes remain isolated under `/api`. */
	readonly staticRoot?: string;
	/** Additional same-origin development origin accepted by the API. */
	readonly developmentOrigin?: string;
}

interface Connection {
	readonly queue: Array<RpcServerMessage | { readonly keepalive: true }>;
	readonly waiters: Array<() => void>;
	readonly maxQueue: number;
	readonly closeResponse: () => void;
	readonly release: () => void;
	closed: boolean;
}

interface ClientState {
	readonly id: string;
	readonly principal: string;
	resumeToken: string;
	resumeTokenExpiresAt: number;
	readonly dispatchers: Map<string, RpcDispatcher>;
	readonly productHosts: Map<string, ProductHost>;
	readonly connections: Set<Connection>;
	readonly requestTimes: number[];
}

interface WebWorkspace {
	readonly id: string;
	readonly name: string;
	readonly root: string;
}

function json(res: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

function tokenFrom(req: IncomingMessage): string | undefined {
	const authorization = req.headers.authorization;
	if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
	const header = req.headers["x-di-code-token"];
	return typeof header === "string" ? header : undefined;
}

function cookieToken(req: IncomingMessage): string | undefined {
	const cookies = req.headers.cookie;
	if (!cookies) return undefined;
	for (const part of cookies.split(";")) {
		const [name, value] = part.trim().split("=", 2);
		if (name === "di_code_web") return value;
	}
	return undefined;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};
const execFileAsync = promisify(execFile);

async function body(req: IncomingMessage, maxBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += data.byteLength;
		if (size > maxBytes) throw new Error("Request body exceeds the permitted size.");
		chunks.push(data);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function requestFromValue(value: unknown): RpcRequest {
	const line = JSON.stringify(value);
	if (!line) throw new Error("RPC body must be a JSON object.");
	return parseRpcRequest(line);
}

/** Local-first HTTP/SSE adapter. It authenticates and queues transport messages; Agent work remains in RpcDispatcher. */
export class WebUiServer {
	private readonly options: WebUiServerOptions;
	private readonly hostManager: HostManager;
	private readonly clients = new Map<string, ClientState>();
	private readonly clientsByResumeToken = new Map<string, ClientState>();
	private readonly server: Server;
	private readonly addedWorkspaceRoots = new Set<string>();
	private readonly removedWorkspaceRoots = new Set<string>();
	private workspaceRegistryLoaded = false;
	private readonly workspaceNames = new Map<string, string>();
	private tokenValue: string;
	private sseConnections = 0;
	private disposed = false;

	constructor(options: WebUiServerOptions) {
		if (options.token === undefined || options.token.length < 32)
			throw new Error("WebUI requires a token of at least 32 characters.");
		if (
			options.resumeTokenTtlMs !== undefined &&
			(!Number.isSafeInteger(options.resumeTokenTtlMs) || options.resumeTokenTtlMs <= 0)
		)
			throw new Error("WebUI resume token TTL must be a positive integer.");
		if (
			(options.maxSseConnectionsPerClient !== undefined &&
				(!Number.isSafeInteger(options.maxSseConnectionsPerClient) || options.maxSseConnectionsPerClient <= 0)) ||
			(options.maxSseConnections !== undefined &&
				(!Number.isSafeInteger(options.maxSseConnections) || options.maxSseConnections <= 0))
		)
			throw new Error("WebUI SSE connection limits must be positive integers.");
		this.options = options;
		this.tokenValue = options.token;
		this.hostManager = new HostManager(options.context);
		this.server = createServer((req, res) => void this.handle(req, res));
	}

	get token(): string {
		return this.tokenValue;
	}
	rotateToken(): string {
		this.tokenValue = randomBytes(32).toString("base64url");
		for (const client of this.clients.values()) this.closeClient(client);
		this.clients.clear();
		this.clientsByResumeToken.clear();
		return this.tokenValue;
	}
	revokeToken(): void {
		this.tokenValue = randomBytes(32).toString("base64url");
		for (const client of this.clients.values()) this.closeClient(client);
		this.clients.clear();
		this.clientsByResumeToken.clear();
	}
	listen(): Promise<{ readonly host: string; readonly port: number }> {
		const host = this.options.host ?? "127.0.0.1";
		if (host !== "127.0.0.1" && host !== "::1" && !this.options.allowRemote)
			return Promise.reject(new Error("Remote WebUI binding requires explicit allowRemote."));
		return new Promise((resolvePromise, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.options.port ?? 0, host, () => {
				const address = this.server.address();
				if (!address || typeof address === "string") return reject(new Error("WebUI did not expose a TCP address."));
				resolvePromise({ host, port: address.port });
			});
		});
	}
	async close(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const client of this.clients.values()) this.closeClient(client);
		await this.hostManager.dispose();
		await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (this.disposed) return json(res, 503, { error: "WebUI is shutting down." });
			if (!this.hostAllowed(req)) return json(res, 403, { error: "Host is not allowed." });
			if (!this.originAllowed(req)) return json(res, 403, { error: "Origin is not allowed." });
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { status: "ok" });
			if (this.options.staticRoot && !isApiRoute(url.pathname)) {
				if (await this.staticAsset(req, res, url)) return;
			}
			this.setCors(req, res);
			if (req.method === "OPTIONS") {
				res.writeHead(204).end();
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/session" && this.isDevelopmentSessionRequest(req)) {
				this.setWebCookie(res);
				res.writeHead(204).end();
				return;
			}
			const client = this.authenticate(req, res, url.pathname.startsWith("/api/"));
			if (!client) return;
			if (!this.rateAllowed(client)) return json(res, 429, { error: "Rate limit exceeded." });
			if (req.method === "GET" && url.pathname === "/api/boot") return await this.boot(res, client, url);
			if (req.method === "POST" && url.pathname === "/api/workspaces") return await this.addWorkspaceRoute(req, res);
			if (req.method === "POST" && url.pathname === "/api/workspaces/rename")
				return await this.renameWorkspaceRoute(req, res);
			if (req.method === "POST" && url.pathname === "/api/workspaces/delete")
				return await this.deleteWorkspaceRoute(req, res);
			if (req.method === "POST" && url.pathname === "/api/workspaces/pick") return await this.pickWorkspaceRoute(res);
			if (req.method === "POST" && url.pathname === "/api/rpc") return await this.rpc(req, res, client, url);
			if (req.method === "GET" && url.pathname === "/api/events") return await this.events(req, res, client, url);
			if (req.method === "POST" && url.pathname === "/api/attachments")
				return await this.attachments(req, res, client, url);
			if (req.method === "POST" && url.pathname === "/rpc") return await this.rpc(req, res, client, url);
			if (req.method === "GET" && url.pathname === "/events") return await this.events(req, res, client, url);
			if (req.method === "POST" && url.pathname === "/attachments")
				return await this.attachments(req, res, client, url);
			json(res, 404, { error: "Not found." });
		} catch {
			json(res, 400, { error: "Request rejected." });
		}
	}

	private authenticate(req: IncomingMessage, res: ServerResponse, allowCookie: boolean): ClientState | undefined {
		const token = tokenFrom(req) ?? (allowCookie ? cookieToken(req) : undefined);
		if (!token || !constantEquals(token, this.tokenValue)) {
			json(res, 401, { error: "Unauthorized." });
			return undefined;
		}
		const requestedResumeToken = req.headers["x-di-code-resume-token"];
		if (typeof requestedResumeToken === "string") {
			const resumed = this.clientsByResumeToken.get(requestedResumeToken);
			if (resumed && resumed.resumeTokenExpiresAt > Date.now()) {
				this.rotateResumeToken(resumed);
				res.setHeader("x-di-code-client-id", resumed.id);
				return resumed;
			}
			if (resumed) this.revokeResumeToken(resumed);
			json(res, 401, { error: "Resume credential is invalid or expired." });
			return undefined;
		}
		const requestedId = req.headers["x-di-code-client-id"];
		const id =
			typeof requestedId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(requestedId)
				? requestedId
				: randomBytes(18).toString("base64url");
		res.setHeader("x-di-code-client-id", id);
		let client = this.clients.get(id);
		if (!client) {
			client = {
				id,
				principal: `webui:${id}`,
				resumeToken: randomBytes(24).toString("base64url"),
				resumeTokenExpiresAt: Date.now() + (this.options.resumeTokenTtlMs ?? 10 * 60 * 1000),
				dispatchers: new Map(),
				productHosts: new Map(),
				connections: new Set(),
				requestTimes: [],
			};
			this.clients.set(id, client);
			this.clientsByResumeToken.set(client.resumeToken, client);
		}
		return client;
	}
	private rotateResumeToken(client: ClientState): void {
		this.clientsByResumeToken.delete(client.resumeToken);
		client.resumeToken = randomBytes(24).toString("base64url");
		client.resumeTokenExpiresAt = Date.now() + (this.options.resumeTokenTtlMs ?? 10 * 60 * 1000);
		this.clientsByResumeToken.set(client.resumeToken, client);
	}
	private revokeResumeToken(client: ClientState): void {
		this.clientsByResumeToken.delete(client.resumeToken);
		client.resumeTokenExpiresAt = 0;
	}
	private hostAllowed(req: IncomingMessage): boolean {
		const host = req.headers.host;
		if (!host) return false;
		try {
			const expected = this.options.host ?? "127.0.0.1";
			return new URL(`http://${host}`).hostname === expected;
		} catch {
			return false;
		}
	}
	private originAllowed(req: IncomingMessage): boolean {
		const origin = req.headers.origin;
		if (origin === undefined) return true;
		const allowed = this.options.origins;
		if (allowed) return allowed.includes(origin) || origin === this.options.developmentOrigin;
		if (origin === this.options.developmentOrigin) return true;
		if (origin === `http://${req.headers.host}`) return true;
		try {
			const parsed = new URL(origin);
			return parsed.protocol === "http:" && parsed.hostname === (this.options.host ?? "127.0.0.1");
		} catch {
			return false;
		}
	}
	private setCors(req: IncomingMessage, res: ServerResponse): void {
		const origin = req.headers.origin;
		if (origin && this.originAllowed(req)) {
			res.setHeader("access-control-allow-origin", origin);
			res.setHeader(
				"access-control-allow-headers",
				"authorization, content-type, x-di-code-token, x-di-code-client-id, x-di-code-resume-token, last-event-id",
			);
			res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
			res.setHeader("vary", "Origin");
		}
	}
	private rateAllowed(client: ClientState): boolean {
		const now = Date.now();
		const config = this.options.rateLimit ?? { windowMs: 10_000, maxRequests: 60 };
		while (client.requestTimes[0] !== undefined && client.requestTimes[0] < now - config.windowMs)
			client.requestTimes.shift();
		if (client.requestTimes.length >= config.maxRequests) return false;
		client.requestTimes.push(now);
		return true;
	}
	private async staticAsset(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
		if (req.method !== "GET" && req.method !== "HEAD") return false;
		const configuredRoot = this.options.staticRoot;
		if (!configuredRoot) return false;
		const staticRoot = await realpath(configuredRoot);
		let pathname: string;
		try {
			pathname = decodeURIComponent(url.pathname);
		} catch {
			json(res, 400, { error: "Invalid URL path." });
			return true;
		}
		if (pathname.includes("\0")) {
			json(res, 400, { error: "Invalid URL path." });
			return true;
		}
		const requested = resolve(staticRoot, `.${pathname}`);
		const pathIsInsideRoot = relative(staticRoot, requested);
		if (pathIsInsideRoot.startsWith("..") || pathIsInsideRoot.startsWith(`..${sep}`)) {
			json(res, 403, { error: "Static path is not allowed." });
			return true;
		}
		const candidate = await this.fileOrFallback(
			requested === staticRoot ? resolve(staticRoot, "index.html") : requested,
			resolve(staticRoot, "index.html"),
		);
		if (!candidate) return false;
		const realCandidate = await realpath(candidate);
		const candidatePath = relative(staticRoot, realCandidate);
		if (candidatePath.startsWith("..") || candidatePath.startsWith(`..${sep}`)) {
			json(res, 403, { error: "Static path is not allowed." });
			return true;
		}
		this.setWebCookie(res);
		const asset = await readFile(realCandidate);
		const cacheControl = realCandidate.endsWith("index.html")
			? "no-cache"
			: realCandidate.includes(`${sep}assets${sep}`)
				? "public, max-age=31536000, immutable"
				: "public, max-age=3600";
		res.writeHead(200, {
			"content-type": MIME_TYPES[extname(realCandidate)] ?? "application/octet-stream",
			"cache-control": cacheControl,
		});
		if (req.method === "GET") res.end(asset);
		else res.end();
		return true;
	}
	private async fileOrFallback(path: string, fallback: string): Promise<string | undefined> {
		try {
			if ((await stat(path)).isFile()) return path;
		} catch {}
		try {
			if ((await stat(fallback)).isFile()) return fallback;
		} catch {}
		return undefined;
	}
	private setWebCookie(res: ServerResponse): void {
		res.setHeader("set-cookie", `di_code_web=${this.tokenValue}; HttpOnly; SameSite=Strict; Path=/`);
	}
	private isDevelopmentSessionRequest(req: IncomingMessage): boolean {
		return this.options.developmentOrigin !== undefined && req.headers.origin === this.options.developmentOrigin;
	}
	private async boot(res: ServerResponse, client: ClientState, url: URL): Promise<void> {
		const { actor, dispatcher } = await this.actor(client, url);
		const workspace = await this.resolveWorkspace(url);
		const [capabilities, state, runtime] = await Promise.all([
			dispatcher.dispatch({
				version: RPC_PROTOCOL_VERSION,
				kind: "request",
				id: `boot-capabilities:${randomUUID()}`,
				method: "get_capabilities",
				params: { events: [] },
			}),
			dispatcher.dispatch({
				version: RPC_PROTOCOL_VERSION,
				kind: "request",
				id: `boot-state:${randomUUID()}`,
				method: "get_state",
				params: {},
			}),
			dispatcher.dispatch({
				version: RPC_PROTOCOL_VERSION,
				kind: "request",
				id: `boot-runtime:${randomUUID()}`,
				method: "get_runtime",
				params: {},
			}),
		]);
		json(res, 200, {
			protocolVersion: RPC_PROTOCOL_VERSION,
			capabilities: capabilities.ok ? capabilities.result : undefined,
			state: state.ok ? state.result.state : actor.state(),
			runtime: runtime.ok ? runtime.result : undefined,
			workspaceId: workspace.id,
			workspaces: (await this.authorizedWorkspaces()).map(({ id, name }) => ({ id, name })),
		});
	}
	private async actor(client: ClientState, url: URL): Promise<{ actor: SessionActor; dispatcher: RpcDispatcher }> {
		const allowed = (await this.resolveWorkspace(url)).root;
		let dispatcher = client.dispatchers.get(allowed);
		if (!dispatcher) {
			const primary = await realpath(resolve(this.options.allowedRoot));
			const projectTrusted =
				allowed.toLowerCase() === primary.toLowerCase()
					? (this.options.projectTrusted ?? false)
					: (await createProjectTrustStore(resolve(this.options.agentDir, "trust.json")).get(allowed)) === true;
			const startupConfiguration = await loadStartupConfiguration(allowed, process.env, this.options.agentDir);
			const hostOptions = this.hostOptions(
				client.principal,
				allowed,
				this.resolveActorRuntime(startupConfiguration),
				projectTrusted,
			);
			let permissionMode = startupConfiguration.permissionMode ?? "ask";
			let requestApproval:
				| ((toolName: string, parameters: unknown, signal?: AbortSignal) => Promise<boolean>)
				| undefined;
			const toolApproval: ToolApprovalCapability = {
				request: async (toolName, parameters, signal) => {
					if (permissionMode === "allow") return;
					if (permissionMode === "deny") throw new Error("Tool approval denied.");
					if (!requestApproval) throw new Error("Tool approval is unavailable.");
					if (!(await requestApproval(toolName, parameters, signal))) throw new Error("Tool approval denied.");
				},
			};
			const actor = await this.hostManager.get({
				...hostOptions,
				principal: client.principal,
				cwd: allowed,
				...(toolApproval ? { toolApproval } : {}),
			});
			if (!actor.state().activeSession) await actor.createSession();
			const product = createProductHost({
				context: this.options.context,
				cwd: allowed,
				agentDir: hostOptions.agentDir,
				projectTrusted,
				provider: hostOptions.provider,
				model: hostOptions.model,
				runtimeSnapshot: () => {
					const ui = actor.ui();
					return {
						providerId: ui.providerId,
						modelId: ui.modelId,
						...(ui.thinkingLevel ? { thinkingLevel: ui.thinkingLevel } : {}),
					};
				},
				startupConfiguration,
				reloadRuntime: async () => {
					const refreshed = await loadStartupConfiguration(allowed, process.env, this.options.agentDir);
					let runtime: StartupRuntime;
					try {
						runtime = resolveStartupRuntime(refreshed.environment, refreshed.providers, refreshed.defaults);
					} catch {
						runtime = resolveStartupRuntime({ DI_CODE_PROVIDER: "faux" }, []);
					}
					actor.setRuntimeValue(runtime.provider, runtime.model);
					return refreshed;
				},
				reloadConfiguration: () => loadStartupConfiguration(allowed, process.env, this.options.agentDir),
				onPermissionModeChange: (mode) => {
					permissionMode = mode;
				},
				refreshResources: (projectTrusted) => actor.refreshResources(projectTrusted),
			});
			const attachments = await createManagedAttachmentStore({
				directory: resolve(this.clientTempRoot(client), "attachments"),
			});
			dispatcher = new RpcDispatcher({
				session: actor,
				commandRegistry: this.options.context.get(commandRegistryKey),
				productState: { projectTrusted },
				productHost: product,
				attachmentStore: attachments,
			});
			const actorDispatcher = dispatcher;
			requestApproval = (toolName, parameters, signal) =>
				actorDispatcher.requestToolApproval(toolName, parameters, signal);
			await actorDispatcher.dispatch({
				version: RPC_PROTOCOL_VERSION,
				kind: "request",
				id: `webui-capabilities:${randomUUID()}`,
				method: "get_capabilities",
				params: {
					events: [
						"sequence",
						"operation_update",
						"snapshot_required",
						"session_changed",
						"tool_approval",
						"product_audit",
					],
				},
			});
			client.productHosts.set(allowed, product);
			client.dispatchers.set(allowed, dispatcher);
		}
		const actor = await this.hostManager.get({
			...this.hostOptions(client.principal, allowed),
			principal: client.principal,
			cwd: allowed,
		});
		return { actor, dispatcher };
	}
	private async authorizedWorkspaces(): Promise<readonly WebWorkspace[]> {
		await this.loadWorkspaceRegistry();
		const primary = await realpath(resolve(this.options.allowedRoot));
		const candidates = [
			this.options.allowedRoot,
			...(this.options.allowedWorkspaces ?? []),
			...this.addedWorkspaceRoots,
		];
		const seen = new Set<string>();
		const result: WebWorkspace[] = [];
		for (const candidate of candidates) {
			let root: string;
			try {
				root = await realpath(resolve(candidate));
			} catch {
				continue;
			}
			const key = root.toLowerCase();
			if (this.removedWorkspaceRoots.has(key)) continue;
			if (seen.has(key)) continue;
			seen.add(key);
			if (key !== primary.toLowerCase()) {
				const trusted = await createProjectTrustStore(resolve(this.options.agentDir, "trust.json")).get(root);
				if (!trusted) continue;
			}
			result.push({
				id: createHash("sha256").update(root).digest("hex").slice(0, 24),
				name: this.workspaceNames.get(key) ?? (basename(root) || "Workspace"),
				root,
			});
		}
		return result;
	}
	private async addWorkspaceRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const value: unknown = JSON.parse(await body(req, 64 * 1024));
		if (typeof value !== "object" || value === null || typeof (value as { readonly path?: unknown }).path !== "string")
			throw new Error("Workspace path is required.");
		const workspace = await this.addWorkspace((value as { readonly path: string }).path);
		json(res, 200, { workspace });
	}
	private async renameWorkspaceRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const value: unknown = JSON.parse(await body(req, 64 * 1024));
		if (typeof value !== "object" || value === null) throw new Error("Workspace details are required.");
		const input = value as { readonly workspaceId?: unknown; readonly name?: unknown };
		if (typeof input.workspaceId !== "string" || typeof input.name !== "string")
			throw new Error("Workspace details are invalid.");
		const workspace = await this.workspaceById(input.workspaceId);
		const name = input.name.trim();
		if (!name || name.length > 120) throw new Error("Workspace name is invalid.");
		this.workspaceNames.set(workspace.root.toLowerCase(), name);
		await this.saveWorkspaceRegistry();
		json(res, 200, { workspace: { id: workspace.id, name } });
	}
	private async deleteWorkspaceRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const value: unknown = JSON.parse(await body(req, 64 * 1024));
		if (
			typeof value !== "object" ||
			value === null ||
			typeof (value as { readonly workspaceId?: unknown }).workspaceId !== "string"
		)
			throw new Error("Workspace ID is required.");
		const workspace = await this.workspaceById((value as { readonly workspaceId: string }).workspaceId);
		const primary = await realpath(resolve(this.options.allowedRoot));
		if (workspace.root.toLowerCase() === primary.toLowerCase())
			throw new Error("The startup workspace cannot be deleted.");
		this.addedWorkspaceRoots.delete(workspace.root);
		this.removedWorkspaceRoots.add(workspace.root.toLowerCase());
		this.workspaceNames.delete(workspace.root.toLowerCase());
		await this.saveWorkspaceRegistry();
		json(res, 200, { deleted: true, workspaceId: workspace.id });
	}
	private async workspaceById(id: string): Promise<WebWorkspace> {
		const workspace = (await this.authorizedWorkspaces()).find((item) => item.id === id);
		if (!workspace) throw new Error("Workspace is not authorized for this WebUI token.");
		return workspace;
	}
	private async pickWorkspaceRoute(res: ServerResponse): Promise<void> {
		const requestedPath = await this.pickWorkspacePath();
		if (!requestedPath) return json(res, 200, { cancelled: true });
		const workspace = await this.addWorkspace(requestedPath);
		json(res, 200, { cancelled: false, workspace });
	}
	private async pickWorkspacePath(): Promise<string | undefined> {
		if (process.platform === "win32") {
			const script =
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }";
			const result = await this.runWorkspacePicker("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
				windowsHide: true,
			});
			return result.stdout.trim() || undefined;
		}
		if (process.platform === "darwin") {
			const result = await this.runWorkspacePicker("osascript", [
				"-e",
				'POSIX path of (choose folder with prompt "Choose a workspace")',
			]);
			return result.stdout.trim() || undefined;
		}
		const result = await this.runWorkspacePicker("zenity", [
			"--file-selection",
			"--directory",
			"--title=Choose a workspace",
		]);
		return result.stdout.trim() || undefined;
	}
	private async runWorkspacePicker(
		command: string,
		args: readonly string[],
		options: { readonly windowsHide?: boolean } = {},
	): Promise<{ readonly stdout: string }> {
		try {
			const result = await execFileAsync(command, [...args], {
				...options,
				timeout: 5 * 60 * 1000,
				maxBuffer: 64 * 1024,
			});
			return { stdout: result.stdout };
		} catch (cause) {
			const error = cause as { readonly code?: number | string; readonly stderr?: string };
			// osascript and zenity use non-zero exit codes for an explicit cancel.
			if (error.code === 1 || error.code === 255 || error.code === -128) return { stdout: "" };
			if (typeof error.code === "string" && error.code === "ENOENT")
				throw new Error(
					`Unable to open the ${command} directory picker. Install ${command} or choose a workspace another way.`,
				);
			throw new Error(`Workspace directory picker failed.${error.stderr?.trim() ? ` ${error.stderr.trim()}` : ""}`);
		}
	}
	/** Adds a validated local directory to this server's explicitly authorized workspace set. */
	private async addWorkspace(requestedPath: string): Promise<Pick<WebWorkspace, "id" | "name">> {
		if (!requestedPath.trim() || requestedPath.includes("\0")) throw new Error("Workspace path is invalid.");
		const root = await realpath(resolve(requestedPath));
		if (!(await stat(root)).isDirectory()) throw new Error("Workspace path is not a directory.");
		const primary = await realpath(resolve(this.options.allowedRoot));
		if (root.toLowerCase() !== primary.toLowerCase()) {
			await createProjectTrustStore(resolve(this.options.agentDir, "trust.json")).set(root, true);
		}
		this.addedWorkspaceRoots.add(root);
		this.removedWorkspaceRoots.delete(root.toLowerCase());
		await this.saveWorkspaceRegistry();
		const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
		return { id, name: this.workspaceNames.get(root.toLowerCase()) ?? (basename(root) || "Workspace") };
	}
	private workspaceRegistryPath(): string {
		return resolve(this.options.workspaceRegistryDir ?? this.options.agentDir, "webui", "workspaces.json");
	}
	private async loadWorkspaceRegistry(): Promise<void> {
		if (this.workspaceRegistryLoaded) return;
		this.workspaceRegistryLoaded = true;
		try {
			const value = JSON.parse(await readFile(this.workspaceRegistryPath(), "utf8")) as {
				readonly roots?: unknown;
				readonly removed?: unknown;
				readonly names?: unknown;
			};
			if (Array.isArray(value.roots))
				for (const root of value.roots) if (typeof root === "string") this.addedWorkspaceRoots.add(root);
			if (Array.isArray(value.removed))
				for (const root of value.removed) if (typeof root === "string") this.removedWorkspaceRoots.add(root);
			if (value.names && typeof value.names === "object")
				for (const [root, name] of Object.entries(value.names as Record<string, unknown>))
					if (typeof name === "string") this.workspaceNames.set(root, name);
		} catch {}
	}
	private async saveWorkspaceRegistry(): Promise<void> {
		await mkdir(resolve(this.options.workspaceRegistryDir ?? this.options.agentDir, "webui"), {
			recursive: true,
		});
		await writeFile(
			this.workspaceRegistryPath(),
			JSON.stringify({
				roots: [...this.addedWorkspaceRoots],
				removed: [...this.removedWorkspaceRoots],
				names: Object.fromEntries(this.workspaceNames.entries()),
			}),
			"utf8",
		);
	}
	private async resolveWorkspace(url: URL): Promise<WebWorkspace> {
		const workspaces = await this.authorizedWorkspaces();
		const id = url.searchParams.get("workspaceId");
		if (id) {
			const selected = workspaces.find((workspace) => workspace.id === id);
			if (selected) return selected;
			throw new Error("Workspace is not authorized for this WebUI token.");
		}
		// Preserve the embedding transport's existing path query while the SPA uses opaque workspace IDs.
		const legacy = url.searchParams.get("workspace");
		if (legacy) {
			const requested = await realpath(resolve(legacy));
			const selected = workspaces.find((workspace) => workspace.root.toLowerCase() === requested.toLowerCase());
			if (selected) return selected;
			throw new Error("Workspace is not authorized for this WebUI token.");
		}
		const primary = workspaces[0];
		if (!primary) throw new Error("No trusted Workspace is available for this WebUI token.");
		return primary;
	}
	private resolveActorRuntime(configuration: StartupConfiguration): StartupRuntime {
		const initialProvider = this.options.provider;
		const initialModel = this.options.model;
		const providerId = configuration.environment.DI_CODE_PROVIDER?.trim() || configuration.defaults?.providerId;
		const modelId =
			configuration.environment.DI_CODE_MODEL?.trim() ||
			(configuration.defaults?.providerId === providerId ? configuration.defaults?.modelId : undefined);
		if (initialProvider && providerId === initialProvider.id && modelId) {
			const model = initialProvider.models.find((candidate) => candidate.id === modelId);
			if (model) return { provider: initialProvider, model };
		}
		try {
			return resolveStartupRuntime(configuration.environment, configuration.providers, configuration.defaults);
		} catch {
			// Embedders may inject a runtime without a corresponding settings file.
			if (initialProvider && initialModel) return { provider: initialProvider, model: initialModel };
			throw new Error("Provider is not configured.");
		}
	}
	private hostOptions(
		_principal: string,
		cwd: string,
		runtime?: StartupRuntime,
		projectTrusted = this.options.projectTrusted,
	): SessionHostBootstrapOptions {
		return {
			cwd,
			// SessionHost uses the same durable root as TUI. Browser identity only
			// scopes transport state and must never become a settings root.
			agentDir: resolve(this.options.agentDir),
			projectTrusted,
			noSkills: this.options.noSkills,
			noContextFiles: this.options.noContextFiles,
			skillPaths: this.options.skillPaths,
			provider: runtime?.provider ?? this.options.provider,
			model: runtime?.model ?? this.options.model,
			signal: this.options.signal,
			compaction: this.options.compaction,
		};
	}
	private clientTempRoot(client: ClientState): string {
		const id = createHash("sha256").update(client.principal).digest("hex");
		return resolve(this.options.agentDir, "webui", "actors", id);
	}
	private async rpc(req: IncomingMessage, res: ServerResponse, client: ClientState, url: URL): Promise<void> {
		const request = requestFromValue(JSON.parse(await body(req, this.options.maxBodyBytes ?? 2 * 1024 * 1024)));
		const { dispatcher } = await this.actor(client, url);
		const response = await dispatcher.dispatch(request);
		json(res, 200, response);
	}
	private async attachments(req: IncomingMessage, res: ServerResponse, client: ClientState, url: URL): Promise<void> {
		// A 5 MiB binary attachment expands to nearly 7 MiB in base64 before JSON framing.
		const value = JSON.parse(await body(req, this.options.maxBodyBytes ?? 10 * 1024 * 1024));
		if (typeof value !== "object" || value === null) throw new Error("Attachment body must be an object.");
		const request = requestFromValue({
			version: RPC_PROTOCOL_VERSION,
			kind: "request",
			id: randomUUID(),
			method: "create_attachment",
			params: value,
		});
		const { dispatcher } = await this.actor(client, url);
		json(res, 200, await dispatcher.dispatch(request));
	}
	private async events(req: IncomingMessage, res: ServerResponse, client: ClientState, url: URL): Promise<void> {
		if (typeof req.headers["x-di-code-resume-token"] === "string") this.closeConnections(client);
		const perClientLimit = this.options.maxSseConnectionsPerClient ?? 8;
		const globalLimit = this.options.maxSseConnections ?? 64;
		if (client.connections.size >= perClientLimit || this.sseConnections >= globalLimit) {
			json(res, 429, { error: "SSE connection limit exceeded." });
			return;
		}
		const { dispatcher } = await this.actor(client, url);
		let released = false;
		const connection: Connection = {
			queue: [],
			waiters: [],
			maxQueue: 128,
			closed: false,
			closeResponse: () => res.end(),
			release: () => {
				if (released) return;
				released = true;
				connection.closed = true;
				connection.waiters.splice(0).forEach((wake) => void wake());
				client.connections.delete(connection);
				this.sseConnections = Math.max(0, this.sseConnections - 1);
			},
		};
		client.connections.add(connection);
		this.sseConnections += 1;
		req.once("close", () => {
			connection.release();
		});
		const unsubscribe = dispatcher.subscribe((message) => {
			if (connection.closed) return;
			if (connection.queue.length >= connection.maxQueue) {
				connection.queue.shift();
				connection.queue.push({ version: 1, kind: "event", requestId: "webui", event: { type: "snapshot_required" } });
			} else connection.queue.push(message);
			connection.waiters.splice(0).forEach((wake) => void wake());
		});
		const keepalive = setInterval(() => {
			if (connection.closed) return;
			if (connection.queue.length >= connection.maxQueue) connection.queue.shift();
			connection.queue.push({ keepalive: true });
			connection.waiters.splice(0).forEach((wake) => void wake());
		}, 15_000);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(`event: ready\ndata: ${JSON.stringify({ resumeToken: client.resumeToken })}\n\n`);
		const last = Number(req.headers["last-event-id"] ?? "0");
		if (Number.isSafeInteger(last) && last >= 0)
			await dispatcher.dispatch({
				version: 1,
				kind: "request",
				id: `resume:${randomUUID()}`,
				method: "resume_events",
				params: { lastSequence: last },
			});
		try {
			while (!connection.closed) {
				const next = connection.queue.shift();
				if (!next) await new Promise<void>((resolvePromise) => connection.waiters.push(resolvePromise));
				else {
					const payload =
						"keepalive" in next
							? ": keepalive\n\n"
							: `${next.kind === "event" && next.sequence !== undefined ? `id: ${next.sequence}\n` : ""}data: ${JSON.stringify(next)}\n\n`;
					if (!res.write(payload)) await new Promise<void>((resolvePromise) => res.once("drain", resolvePromise));
				}
			}
		} finally {
			clearInterval(keepalive);
			unsubscribe();
			connection.release();
		}
	}
	private closeConnections(client: ClientState): void {
		for (const connection of client.connections) {
			connection.release();
			connection.closeResponse();
		}
	}
	private closeClient(client: ClientState): void {
		this.closeConnections(client);
		for (const dispatcher of client.dispatchers.values()) void dispatcher.dispose();
		for (const product of client.productHosts.values()) void product.dispose();
		client.dispatchers.clear();
		client.productHosts.clear();
		this.clientsByResumeToken.delete(client.resumeToken);
	}
}

function constantEquals(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function isApiRoute(pathname: string): boolean {
	return (
		pathname === "/rpc" ||
		pathname === "/events" ||
		pathname === "/attachments" ||
		pathname === "/healthz" ||
		pathname.startsWith("/api/")
	);
}
