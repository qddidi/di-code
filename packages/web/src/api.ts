import type { BootData, RpcEnvelope, SessionsResult } from "./types.ts";

async function fetchBoot(): Promise<Response> {
	const response = await fetch("/api/boot", { credentials: "same-origin" });
	if (response.status !== 401) return response;

	const session = await fetch("/api/session", { credentials: "same-origin" });
	if (!session.ok) return response;
	return await fetch("/api/boot", { credentials: "same-origin" });
}

export async function loadBootData(): Promise<BootData> {
	const response = await fetchBoot();
	if (!response.ok) throw new Error(`Server returned ${response.status}.`);
	return (await response.json()) as BootData;
}

export async function callRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	const response = await fetch("/api/rpc", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ version: 1, kind: "request", id: crypto.randomUUID(), method, params }),
	});
	if (!response.ok) throw new Error(`RPC request failed (${response.status}).`);
	const envelope = (await response.json()) as RpcEnvelope<T>;
	if (!envelope.ok || envelope.result === undefined) throw new Error(envelope.error?.message ?? "RPC request failed.");
	return envelope.result;
}

export async function loadSessions(): Promise<SessionsResult> {
	return callRpc<SessionsResult>("list_sessions");
}
