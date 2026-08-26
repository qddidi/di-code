import type { AttachmentInfo, BootData, RpcEnvelope, SessionsResult, SettingsSnapshot } from "./types.ts";

const CLIENT_ID_KEY = "di-code-web-client-id";

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
	const response = await fetch("/api/boot", { credentials: "same-origin" });
	if (response.status !== 401) return response;

	const session = await fetch("/api/session", { credentials: "same-origin" });
	if (!session.ok) return response;
	return await fetch("/api/boot", { credentials: "same-origin" });
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
	const response = await fetch("/api/rpc", {
		method: "POST",
		credentials: "same-origin",
		headers: clientHeaders({ "content-type": "application/json" }),
		body: JSON.stringify({ version: 1, kind: "request", id: requestId, method, params }),
	});
	rememberClient(response);
	if (!response.ok) throw new Error(`RPC request failed (${response.status}).`);
	const envelope = (await response.json()) as RpcEnvelope<T>;
	if (!envelope.ok || envelope.result === undefined) throw new Error(envelope.error?.message ?? "RPC request failed.");
	return envelope.result;
}

export async function uploadAttachment(input: {
	readonly name: string;
	readonly contentType: AttachmentInfo["contentType"];
	readonly data: string;
}): Promise<AttachmentInfo> {
	const response = await fetch("/api/attachments", {
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

export async function loadSessions(): Promise<SessionsResult> {
	return callRpc<SessionsResult>("list_sessions");
}

export async function loadSettings(): Promise<SettingsSnapshot> {
	const result = await callRpc<{ readonly method: "get_settings"; readonly settings: SettingsSnapshot }>(
		"get_settings",
	);
	return result.settings;
}
