export interface BootData {
	readonly protocolVersion: number;
	readonly capabilities: { readonly methods: readonly string[]; readonly events: readonly string[] };
	readonly state: { readonly modelId: string; readonly messageCount: number };
	readonly runtime: { readonly providerId: string; readonly modelId: string };
}

export interface SessionSummary {
	readonly id: string;
	readonly label: string;
	readonly modifiedAt?: string;
}

export interface RpcEnvelope<T> {
	readonly ok: boolean;
	readonly result?: T;
	readonly error?: { readonly message?: string };
}

export interface SessionsResult {
	readonly method: "list_sessions";
	readonly sessions: readonly SessionSummary[];
}
