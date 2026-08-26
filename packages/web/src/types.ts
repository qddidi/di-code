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

export interface SettingsSnapshot {
	readonly providers: readonly {
		readonly id: string;
		readonly name: string;
		readonly models: readonly { readonly id: string; readonly name: string; readonly input: readonly string[] }[];
		readonly configured: boolean;
		readonly api: string;
		readonly baseUrl?: string;
		readonly apiKeySource: "environment" | "settings" | "missing";
	}[];
	readonly defaults: { readonly providerId?: string; readonly modelId?: string };
	readonly runtime: { readonly providerId: string; readonly modelId: string; readonly thinkingLevel?: string };
	readonly locale?: "en" | "zh-CN";
	readonly permissionMode: "ask" | "allow" | "deny";
	readonly sources: Readonly<Record<string, string>>;
}
