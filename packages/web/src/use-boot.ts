import { useEffect, useState } from "react";
import { loadBootData, loadSessionsForWorkspace } from "./api.ts";
import type { BootData, SessionSummary } from "./types.ts";

export interface BootState {
	readonly data?: BootData;
	readonly error?: string;
	readonly loading: boolean;
	readonly sessions: readonly SessionSummary[];
	readonly sessionsLoading: boolean;
	readonly workspaceSessions: Readonly<Record<string, readonly SessionSummary[]>>;
}

export function useBoot(): BootState {
	const [data, setData] = useState<BootData>();
	const [error, setError] = useState<string>();
	const [workspaceSessions, setWorkspaceSessions] = useState<Readonly<Record<string, readonly SessionSummary[]>>>({});
	const [sessionsLoading, setSessionsLoading] = useState(true);

	useEffect(() => {
		let active = true;
		void loadBootData()
			.then(async (value) => {
				if (!active) return;
				setData(value);
				const entries = await Promise.all(
					value.workspaces.map(async (workspace) => {
						try {
							return [workspace.id, (await loadSessionsForWorkspace(workspace.id)).sessions] as const;
						} catch {
							return [workspace.id, [] as readonly SessionSummary[]] as const;
						}
					}),
				);
				if (active) setWorkspaceSessions(Object.fromEntries(entries));
			})
			.catch((cause: unknown) => {
				if (active) setError(cause instanceof Error ? cause.message : "Unable to connect.");
			})
			.finally(() => {
				if (active) setSessionsLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	return {
		data,
		error,
		loading: data === undefined && error === undefined,
		sessions: workspaceSessions[data?.workspaceId ?? ""] ?? [],
		sessionsLoading,
		workspaceSessions,
	};
}
