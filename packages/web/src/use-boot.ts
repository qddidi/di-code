import { useEffect, useState } from "react";
import { loadBootData, loadSessions } from "./api.ts";
import type { BootData, SessionSummary } from "./types.ts";

export interface BootState {
	readonly data?: BootData;
	readonly error?: string;
	readonly loading: boolean;
	readonly sessions: readonly SessionSummary[];
	readonly sessionsLoading: boolean;
}

export function useBoot(): BootState {
	const [data, setData] = useState<BootData>();
	const [error, setError] = useState<string>();
	const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
	const [sessionsLoading, setSessionsLoading] = useState(true);

	useEffect(() => {
		let active = true;
		void loadBootData()
			.then((value) => {
				if (active) setData(value);
			})
			.catch((cause: unknown) => {
				if (active) setError(cause instanceof Error ? cause.message : "Unable to connect.");
			});
		void loadSessions()
			.then((value) => {
				if (active) setSessions(value.sessions);
			})
			.catch(() => undefined)
			.finally(() => {
				if (active) setSessionsLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	return { data, error, loading: data === undefined && error === undefined, sessions, sessionsLoading };
}
