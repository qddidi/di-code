import type {
	AttachmentInfo,
	BootData,
	McpServerSummary,
	PluginSummary,
	RpcEnvelope,
	SessionSummary,
	SessionsResult,
	SettingsSnapshot,
	SkillSummary,
	WebManifest,
	WorkspaceSummary,
} from "./types.ts";

const CLIENT_ID_KEY = "di-code-web-client-id";
let workspaceId: string | undefined;

/** Selects the opaque workspace handle used for all subsequent WebUI requests. */
export function selectWorkspace(id: string | undefined): void {
	workspaceId = id;
}

function apiPath(path: string, selectedWorkspaceId = workspaceId): string {
	if (!selectedWorkspaceId) return path;
	const url = new URL(path, window.location.origin);
	url.searchParams.set("workspaceId", selectedWorkspaceId);
	return `${url.pathname}${url.search}`;
}

function clientHeaders(headers: HeadersInit = {}): Headers {
	const result = new Headers(headers);
	const clientId = sessionStorage.getItem(CLIENT_ID_KEY);
	if (clientId) result.set("x-di-code-client-id", clientId);
	return result;
}

/** Keeps HTTP RPC and SSE attached to the same server-side WebUI actor. */
export function rememberClient(response: Response): void {
	const clientId = response.headers.get("x-di-code-client-id");
	if (clientId) sessionStorage.setItem(CLIENT_ID_KEY, clientId);
}

async function fetchBoot(): Promise<Response> {
	const response = await fetch(apiPath("/api/boot"), { credentials: "same-origin" });
	if (response.status !== 401) return response;

	const session = await fetch("/api/session", { credentials: "same-origin" });
	if (!session.ok) return response;
	return await fetch(apiPath("/api/boot"), { credentials: "same-origin" });
}

export async function loadBootData(): Promise<BootData> {
	const response = await fetchBoot();
	rememberClient(response);
	if (!response.ok) throw new Error(`Server returned ${response.status}.`);
	return (await response.json()) as BootData;
}

export async function callRpc<T>(
	method: string,
	params: Record<string, unknown> = {},
	requestId = crypto.randomUUID(),
): Promise<T> {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const response = await fetch(apiPath("/api/rpc"), {
			method: "POST",
			credentials: "same-origin",
			headers: clientHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ version: 1, kind: "request", id: requestId, method, params }),
		});
		rememberClient(response);
		let envelope: RpcEnvelope<T> | undefined;
		try {
			envelope = (await response.json()) as RpcEnvelope<T>;
		} catch {
			if (!response.ok) {
				if (response.status === 429 && attempt < 3) {
					await retryDelay(response, attempt);
					continue;
				}
				throw new Error(`RPC request failed (${response.status}).`);
			}
			throw new Error("RPC request returned invalid JSON.");
		}
		if (!response.ok) {
			if (response.status === 429 && attempt < 3) {
				await retryDelay(response, attempt);
				continue;
			}
			throw new Error(envelope.error?.message ?? `RPC request failed (${response.status}).`);
		}
		if (!envelope.ok || envelope.result === undefined)
			throw new Error(envelope.error?.message ?? "RPC request failed.");
		return envelope.result;
	}
	throw new Error("RPC request was rate limited. Please try again.");
}

async function retryDelay(response: Response, attempt: number): Promise<void> {
	const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
	const delay = Number.isFinite(retryAfter) ? Math.min(5_000, Math.max(100, retryAfter * 1_000)) : 250 * 2 ** attempt;
	await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}

export async function uploadAttachment(input: {
	readonly sessionId: string;
	readonly name: string;
	readonly contentType: AttachmentInfo["contentType"];
	readonly data: string;
}): Promise<AttachmentInfo> {
	const response = await fetch(apiPath("/api/attachments"), {
		method: "POST",
		credentials: "same-origin",
		headers: clientHeaders({ "content-type": "application/json" }),
		body: JSON.stringify(input),
	});
	rememberClient(response);
	if (!response.ok) throw new Error(`Attachment upload failed (${response.status}).`);
	const envelope = (await response.json()) as RpcEnvelope<{ readonly attachment: AttachmentInfo }>;
	if (!envelope.ok || envelope.result === undefined)
		throw new Error(envelope.error?.message ?? "Attachment upload failed.");
	return envelope.result.attachment;
}

export function eventHeaders(lastSequence: number, resumeToken?: string): Headers {
	const headers = clientHeaders();
	if (lastSequence > 0) headers.set("last-event-id", String(lastSequence));
	if (resumeToken) headers.set("x-di-code-resume-token", resumeToken);
	return headers;
}

export function eventsPath(): string {
	return apiPath("/api/events");
}

export async function loadSessions(): Promise<SessionsResult> {
	return callRpc<SessionsResult>("list_sessions");
}

/** Reads a workspace's sessions without changing the active workspace actor. */
export async function loadSessionsForWorkspace(selectedWorkspaceId: string): Promise<SessionsResult> {
	const response = await fetch(apiPath("/api/rpc", selectedWorkspaceId), {
		method: "POST",
		credentials: "same-origin",
		headers: clientHeaders({ "content-type": "application/json" }),
		body: JSON.stringify({
			version: 1,
			kind: "request",
			id: crypto.randomUUID(),
			method: "list_sessions",
			params: {},
		}),
	});
	rememberClient(response);
	if (!response.ok) throw new Error(`RPC request failed (${response.status}).`);
	const envelope = (await response.json()) as RpcEnvelope<SessionsResult>;
	if (!envelope.ok || envelope.result === undefined) throw new Error(envelope.error?.message ?? "RPC request failed.");
	return envelope.result;
}

export async function addWorkspace(path?: string): Promise<WorkspaceSummary | undefined> {
	const response = await fetch(apiPath(path ? "/api/workspaces" : "/api/workspaces/pick"), {
		method: "POST",
		credentials: "same-origin",
		headers: clientHeaders({ "content-type": "application/json" }),
		...(path ? { body: JSON.stringify({ path }) } : {}),
	});
	rememberClient(response);
	if (!response.ok) {
		let message = "Unable to add workspace.";
		try {
			const error = (await response.json()) as { readonly error?: unknown };
			if (typeof error.error === "string" && error.error.trim()) message = error.error;
		} catch {}
		throw new Error(message);
	}
	const result = (await response.json()) as { readonly cancelled?: boolean; readonly workspace?: WorkspaceSummary };
	return result.cancelled ? undefined : result.workspace;
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceSummary> {
	const response = await fetch(apiPath("/api/workspaces/rename"), {
		method: "POST",
		credentials: "same-origin",
		headers: clientHeaders({ "content-type": "application/json" }),
		body: JSON.stringify({ workspaceId, name }),
	});
	rememberClient(response);
	if (!response.ok) throw new Error("Unable to rename workspace.");
	const result = (await response.json()) as { readonly workspace: WorkspaceSummary };
	return result.workspace;
}
export async function deleteWorkspace(workspaceId: string): Promise<void> {
	const response = await fetch(apiPath("/api/workspaces/delete"), {
		method: "POST",
		credentials: "same-origin",
		headers: clientHeaders({ "content-type": "application/json" }),
		body: JSON.stringify({ workspaceId }),
	});
	rememberClient(response);
	if (!response.ok) throw new Error("Unable to delete workspace.");
}

export async function loadSettings(): Promise<SettingsSnapshot> {
	const result = await callRpc<{ readonly method: "get_settings"; readonly settings: SettingsSnapshot }>(
		"get_settings",
	);
	return result.settings;
}

export async function renameSession(sessionId: string, label: string): Promise<void> {
	await callRpc("rename_session", { sessionId, label });
}
export async function deleteSession(sessionId: string): Promise<void> {
	await callRpc("delete_session", { sessionId, confirmation: sessionId });
}
export async function branchSession(sessionId: string, entryId?: string): Promise<SessionSummary> {
	const result = await callRpc<{ readonly session: SessionSummary }>("branch_session", {
		sessionId,
		...(entryId ? { entryId } : {}),
	});
	return result.session;
}
export async function inspectSession(sessionId: string): Promise<unknown> {
	const result = await callRpc<{ readonly snapshot: unknown }>("inspect_session", { sessionId });
	return result.snapshot;
}

export async function loadSkills(): Promise<readonly SkillSummary[]> {
	const result = await callRpc<{ readonly skills: readonly SkillSummary[] }>("list_skills");
	return result.skills;
}
export async function loadMcpServers(): Promise<readonly McpServerSummary[]> {
	const result = await callRpc<{ readonly servers: readonly McpServerSummary[] }>("list_mcp_servers");
	return result.servers;
}
export async function loadPlugins(): Promise<readonly PluginSummary[]> {
	const result = await callRpc<{ readonly plugins: readonly PluginSummary[] }>("list_plugins");
	return result.plugins;
}
export async function loadWebContributions(): Promise<WebManifest> {
	const result = await callRpc<{ readonly manifest: WebManifest }>("list_web_contributions");
	return result.manifest;
}

export async function respondInteraction(
	sessionId: string,
	runId: string,
	requestId: string,
	result: {
		readonly status: "answered" | "cancelled" | "timeout";
		readonly value?: string;
		readonly approved?: boolean;
		readonly feedback?: string;
	},
): Promise<void> {
	await callRpc("respond_interaction", { sessionId, runId, requestId, ...result });
}
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginSummary> {
	const result = await callRpc<{ readonly plugin: PluginSummary }>("set_plugin_enabled", { pluginId, enabled });
	return result.plugin;
}
export async function setProjectTrust(trusted: boolean): Promise<boolean> {
	const result = await callRpc<{ readonly trusted: boolean }>("set_project_trust", { trusted });
	return result.trusted;
}

export async function loadProjectResourceSummary(): Promise<{
	readonly hasProjectResources: boolean;
	readonly projectTrusted: boolean;
}> {
	const [trust, plugins, skills, mcp] = await Promise.all([
		callRpc<{ readonly trusted: boolean }>("get_project_trust"),
		loadPlugins(),
		callRpc<{ readonly skills: readonly SkillSummary[]; readonly projectResourcesDetected?: boolean }>("list_skills"),
		loadMcpServers(),
	]);
	return {
		projectTrusted: trust.trusted,
		hasProjectResources:
			plugins.some((plugin) => plugin.source === "project") ||
			Boolean(skills.projectResourcesDetected) ||
			skills.skills.some((skill) => skill.scope === "project") ||
			mcp.some((server) => server.scope === "project"),
	};
}
