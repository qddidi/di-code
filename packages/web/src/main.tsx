import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface BootData {
	readonly protocolVersion: number;
	readonly capabilities: { readonly methods: readonly string[]; readonly events: readonly string[] };
	readonly state: { readonly modelId: string; readonly messageCount: number };
	readonly runtime: { readonly providerId: string; readonly modelId: string };
}

function App(): React.JSX.Element {
	const [boot, setBoot] = useState<BootData>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		const boot = (): Promise<Response> => fetch("/api/boot", { credentials: "same-origin" });
		void boot()
			.then(async (response) => {
				if (response.status !== 401) return response;
				const session = await fetch("/api/session", { credentials: "same-origin" });
				if (!session.ok) return response;
				return await boot();
			})
			.then(async (response) => {
				if (!response.ok) throw new Error(`Server returned ${response.status}.`);
				return (await response.json()) as BootData;
			})
			.then(setBoot)
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to connect."));
	}, []);

	return (
		<main className="shell">
			<header>
				<div className="brand">di-code</div>
				<span className={boot ? "status ready" : error ? "status error" : "status"}>
					{boot ? "Connected" : error ? "Unavailable" : "Connecting"}
				</span>
			</header>
			<section aria-live="polite" className="content">
				<h1>Workspace session</h1>
				{error ? <p className="error-message">{error}</p> : null}
				{boot ? (
					<dl className="details">
						<div><dt>Provider</dt><dd>{boot.runtime.providerId}</dd></div>
						<div><dt>Model</dt><dd>{boot.runtime.modelId}</dd></div>
						<div><dt>Capabilities</dt><dd>{boot.capabilities.methods.length} RPC methods</dd></div>
						<div><dt>Session messages</dt><dd>{boot.state.messageCount}</dd></div>
					</dl>
				) : <p className="loading">Loading workspace capabilities...</p>}
			</section>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
