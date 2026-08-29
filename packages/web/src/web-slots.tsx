import { Component, useMemo } from "react";
import { WebSlotRegistry, type RegistryOwner, type WebContribution as RuntimeWebContribution, type WebSlotId } from "@di-code/plugin-runtime";
import type { WebContribution, WebManifest } from "./types.ts";

export interface WebSlotActions {
	readonly openSettings: () => void;
	readonly focusSession: (sessionId: string) => void;
}

export interface WebSlotProps {
	readonly contribution: WebContribution;
	readonly data: Readonly<Record<string, string | number | boolean | null>>;
	readonly context: Readonly<{ sessionId?: string; toolName?: string; status?: string; projections?: Readonly<Record<string, { readonly version: number; readonly state: unknown }>> }>;
	readonly actions: WebSlotActions;
	readonly signal: AbortSignal;
}

type ComponentRenderer = (props: WebSlotProps) => React.JSX.Element;
const builtinComponents: Readonly<Record<string, ComponentRenderer>> = {
	"builtin.workspace-status": ({ data }) => <span className="web-contribution-badge">{String(data.label ?? "Workspace")}</span>,
	"builtin.session-inspector": ({ context, actions, data }) => <button className="web-contribution-link" type="button" onClick={() => context.sessionId && actions.focusSession(context.sessionId)}>{String(data.label ?? "Inspect session")}</button>,
	"builtin.assistant-badge": ({ data }) => <aside className="web-contribution-node" aria-label="Plugin contribution">{String(data.label ?? "Agent activity")}</aside>,
	"builtin.tool-audit": ({ context, data }) => <span className="web-contribution-tool">{String(data.label ?? "Tool audit")}{context.toolName ? `: ${context.toolName}` : ""}</span>,
	"builtin.plugin-diagnostics": ({ actions, data }) => <button className="web-contribution-link" type="button" onClick={actions.openSettings}>{String(data.label ?? "Plugin diagnostics")}</button>,
	"builtin.extension-badge": ({ data }) => <span className="web-extension-badge" role="status">{String(data.label ?? "Extension")}</span>,
	"builtin.extension-control": ({ actions, data }) => <button className="web-contribution-link" type="button" onClick={actions.openSettings}>{String(data.label ?? "Open extension")}</button>,
	"builtin.review-panel": ({ actions, data }) => <section className="web-review-panel" aria-label="Extension review"><strong>{String(data.label ?? "Review")}</strong>{data.actionLabel ? <button type="button" onClick={actions.openSettings}>{String(data.actionLabel)}</button> : null}</section>,
	"builtin.composer-placeholder": ({ data }) => <span className="web-composer-placeholder">{String(data.label ?? "Extension input")}</span>,
};

class ContributionBoundary extends Component<{ readonly children: React.ReactNode }, { readonly failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError(): { readonly failed: boolean } { return { failed: true }; }
	render(): React.ReactNode { return this.state.failed ? null : this.props.children; }
}

export interface WebSlotHost {
	readonly registry: WebSlotRegistry;
	readonly diagnostics: readonly string[];
	readonly render: (slot: WebSlotId, props: Pick<WebSlotProps, "context" | "actions" | "signal">) => React.JSX.Element[];
	readonly dispose: () => void;
}

function asRuntimeContribution(value: WebContribution): RuntimeWebContribution {
	return value as RuntimeWebContribution;
}

export function createWebSlotHost(manifest: WebManifest, actions: WebSlotActions): WebSlotHost {
	const registry = new WebSlotRegistry();
	const diagnostics: string[] = [];
	const owner: RegistryOwner = { fiberId: "web-host", pluginName: "web-host" };
	for (const contribution of manifest.contributions) {
		try {
			if (!builtinComponents[contribution.componentKey]) {
				diagnostics.push(`Skipped untrusted Web component: ${contribution.componentKey}`);
				continue;
			}
			registry.register(asRuntimeContribution(contribution), owner);
		} catch (cause) {
			diagnostics.push(cause instanceof Error ? cause.message : "Web contribution registration failed.");
		}
	}
	return {
		registry,
		diagnostics: Object.freeze(diagnostics),
		dispose: () => registry.dispose(),
		render: (slot, props) => registry.list(slot).flatMap((entry) => {
			const renderer = builtinComponents[entry.componentKey];
			if (!renderer) return [];
			const contribution = entry as unknown as WebContribution;
			const Renderer = renderer;
			return [<ContributionBoundary key={`${slot}:${entry.id}`}><span className="web-contribution-slot"><Renderer contribution={contribution} data={contribution.data ?? {}} context={props.context} actions={actions} signal={props.signal} /></span></ContributionBoundary>];
		}),
	};
}

export function WebSlot({ host, slot, context, actions, signal }: { readonly host: WebSlotHost; readonly slot: WebSlotId; readonly context: WebSlotProps["context"]; readonly actions: WebSlotActions; readonly signal: AbortSignal }): React.JSX.Element | null {
	const rendered = useMemo(() => host.render(slot, { context, actions, signal }), [host, slot, context, actions, signal]);
	return rendered.length ? <>{rendered}</> : null;
}
