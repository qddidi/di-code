import type { BootData } from "../types.ts";

export function BootDetails({ boot }: { readonly boot: BootData }): React.JSX.Element {
	return (
		<dl className="details">
			<div>
				<dt>Provider</dt>
				<dd>{boot.runtime.providerId}</dd>
			</div>
			<div>
				<dt>Model</dt>
				<dd>{boot.runtime.modelId}</dd>
			</div>
			<div>
				<dt>Capabilities</dt>
				<dd>{boot.capabilities.methods.length} RPC methods</dd>
			</div>
			<div>
				<dt>Session messages</dt>
				<dd>{boot.state.messageCount}</dd>
			</div>
		</dl>
	);
}
