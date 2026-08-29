import type { AgentTool, AgentToolResult } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";
import type {
	PromptSectionRegistry,
	SessionEventEnvelope,
	SessionToolPolicy,
	UserInteraction,
} from "@di-code/plugin-sdk";

export const PLAN_MODE_API_VERSION = 1 as const;
export const PLAN_EVENT_NAMESPACE = "plan" as const;
export const PLAN_EVENT_NAME = "mode" as const;
export const PLAN_SELECTION_EVENT_NAME = "selection" as const;
export const PLAN_EVENT_SCHEMA_VERSION = 1 as const;
export const PLAN_PROJECTION_NAME = "mode" as const;
export const EXIT_PLAN_MODE = "exit_plan_mode" as const;

export interface PlanModeConfig {
	readonly section: string;
}

export interface PlanModeProjection {
	readonly active: boolean;
	readonly pending: boolean;
}

export interface PlanModeAdapter {
	readonly sessionId: string;
	readonly events: () => readonly SessionEventEnvelope[];
	readonly appendEvent: (event: SessionEventEnvelope, signal?: AbortSignal) => Promise<void>;
	readonly isBusy?: () => boolean;
	readonly promptSections?: PromptSectionRegistry;
	readonly interaction?: UserInteraction;
	readonly now?: () => number;
}

export type PlanSelectionResult = "committed" | "queued" | "cancelled" | "noop";

const mutationTools = new Set(["write", "edit", "bash"]);
const exitParameters = Type.Object({ plan: Type.String({ minLength: 1 }) });
export type ExitPlanParameters = Static<typeof exitParameters>;

function isPlanModeEvent(
	event: SessionEventEnvelope,
): event is SessionEventEnvelope & { payload: { active: boolean } } {
	return (
		event.namespace === PLAN_EVENT_NAMESPACE &&
		event.eventName === PLAN_EVENT_NAME &&
		event.schemaVersion === PLAN_EVENT_SCHEMA_VERSION &&
		typeof event.payload === "object" &&
		event.payload !== null &&
		!Array.isArray(event.payload) &&
		typeof (event.payload as { active?: unknown }).active === "boolean"
	);
}

function isPlanSelectionEvent(
	event: SessionEventEnvelope,
): event is SessionEventEnvelope & { payload: { active: boolean } } {
	return (
		event.namespace === PLAN_EVENT_NAMESPACE &&
		event.eventName === PLAN_SELECTION_EVENT_NAME &&
		event.schemaVersion === PLAN_EVENT_SCHEMA_VERSION &&
		typeof event.payload === "object" &&
		event.payload !== null &&
		!Array.isArray(event.payload) &&
		typeof (event.payload as { active?: unknown }).active === "boolean"
	);
}

function loggedActive(events: readonly SessionEventEnvelope[]): boolean {
	for (const event of [...events].reverse()) if (isPlanModeEvent(event)) return event.payload.active;
	return false;
}

function modeEvent(active: boolean): SessionEventEnvelope {
	return {
		namespace: PLAN_EVENT_NAMESPACE,
		eventName: PLAN_EVENT_NAME,
		schemaVersion: PLAN_EVENT_SCHEMA_VERSION,
		payload: { active },
	};
}

function selectionEvent(active: boolean): SessionEventEnvelope {
	return {
		namespace: PLAN_EVENT_NAMESPACE,
		eventName: PLAN_SELECTION_EVENT_NAME,
		schemaVersion: PLAN_EVENT_SCHEMA_VERSION,
		payload: { active },
	};
}

function validateConfig(config: PlanModeConfig): PlanModeConfig {
	if (typeof config?.section !== "string" || config.section.trim() === "")
		throw new TypeError("PlanModeConfig.section must be a non-empty string.");
	const unknown = Object.keys(config).filter((key) => key !== "section");
	if (unknown.length > 0) throw new TypeError(`Unknown PlanModeConfig keys: ${unknown.join(", ")}`);
	return { section: config.section };
}

/** Pure replay of the durable plan mode event. */
export function foldPlanMode(events: readonly SessionEventEnvelope[]): boolean {
	return loggedActive(events);
}

/** Derives the protocol projection from the durable log and an in-memory pending selection. */
export function projectPlanMode(
	events: readonly SessionEventEnvelope[],
	pending: boolean | undefined,
): PlanModeProjection {
	let active = false;
	let replayPending: boolean | undefined;
	for (const event of events) {
		if (isPlanSelectionEvent(event)) replayPending = event.payload.active;
		if (isPlanModeEvent(event)) {
			active = event.payload.active;
			if (replayPending === active) replayPending = undefined;
		}
	}
	const selected = pending ?? replayPending;
	return { active, pending: selected !== undefined && selected !== active };
}

/** Session-event validator used when registering `plan/mode` with the SDK registry. */
export function validatePlanModePayload(value: unknown): value is { readonly active: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { active?: unknown }).active === "boolean"
	);
}

/**
 * Session-scoped plan controller. The adapter owns persistence and interaction;
 * this module only contributes typed events, prompt text, policy and tools.
 */
export class PlanModeController {
	readonly apiVersion = PLAN_MODE_API_VERSION;
	private readonly config: PlanModeConfig;
	private readonly adapter: PlanModeAdapter;
	private pending: { active: boolean; narrate: boolean } | undefined;
	private disposed = false;
	private unregisterSection?: () => void;

	constructor(adapter: PlanModeAdapter, config: PlanModeConfig) {
		this.adapter = adapter;
		this.config = validateConfig(config);
		if (adapter.promptSections) {
			this.unregisterSection = adapter.promptSections.register({
				name: "plan:policy",
				order: 50,
				owner: "plan-mode",
				generate: () => (this.get().active || this.pending?.active === true ? this.config.section : undefined),
			});
		}
	}

	get(): PlanModeProjection {
		return projectPlanMode(this.adapter.events(), this.pending?.active);
	}

	/** Selects a mode; busy sessions defer the durable write until pre-step. */
	set(active: boolean): PlanSelectionResult {
		this.assertOpen();
		const current = this.pending?.active ?? loggedActive(this.adapter.events());
		if (current === active) return "noop";
		if (this.adapter.isBusy?.()) {
			this.pending = { active, narrate: true };
			void this.adapter.appendEvent(selectionEvent(active)).catch(() => undefined);
			return loggedActive(this.adapter.events()) === active ? "cancelled" : "queued";
		}
		if (loggedActive(this.adapter.events()) === active) {
			this.pending = undefined;
			return "cancelled";
		}
		void this.commitSelection(active);
		return "committed";
	}

	/** Awaitable variant for hosts that need durable-write failure surfaced to the caller. */
	async setAsync(active: boolean): Promise<PlanSelectionResult> {
		this.assertOpen();
		const current = this.pending?.active ?? loggedActive(this.adapter.events());
		if (current === active) return "noop";
		if (this.adapter.isBusy?.()) {
			this.pending = { active, narrate: true };
			await this.adapter.appendEvent(selectionEvent(active));
			return loggedActive(this.adapter.events()) === active ? "cancelled" : "queued";
		}
		if (loggedActive(this.adapter.events()) === active) {
			this.pending = undefined;
			return "cancelled";
		}
		await this.adapter.appendEvent(selectionEvent(active));
		if (this.adapter.isBusy?.()) {
			this.pending = { active, narrate: true };
			return "queued";
		}
		await this.adapter.appendEvent(modeEvent(active));
		this.pending = undefined;
		return "committed";
	}

	/** Commits a pending selection at the accepted pre-step boundary. */
	async preStep(signal?: AbortSignal): Promise<void> {
		this.assertOpen();
		const projection = projectPlanMode(this.adapter.events(), this.pending?.active);
		const pending = this.pending ?? (projection.pending ? { active: !projection.active, narrate: false } : undefined);
		if (!pending) return;
		if (projection.active === pending.active) {
			this.pending = undefined;
			return;
		}
		await this.adapter.appendEvent(selectionEvent(pending.active), signal);
		await this.adapter.appendEvent(modeEvent(pending.active), signal);
		this.pending = undefined;
	}

	/** Direct command implementation. The command itself is never persisted as a user message. */
	async command(args: string, steer?: (message: string) => Promise<void>): Promise<string> {
		const trimmed = args.trim();
		if (trimmed === "off") {
			const result = await this.setAsync(false);
			return result === "committed"
				? "Plan mode off."
				: result === "queued"
					? "Leaving plan mode at the next step."
					: "Plan mode is already inactive.";
		}
		const result = await this.setAsync(true);
		if (trimmed && steer) await steer(trimmed);
		return result === "committed" ? "Plan mode on." : "Entering plan mode at the next step.";
	}

	/** Host-enforced mutation gate for write/edit/bash and other declared mutations. */
	authorize(toolName: string): void {
		if (this.get().active && mutationTools.has(toolName)) {
			const error = new Error(`Tool ${toolName} is denied while plan mode is active.`);
			Object.assign(error, { code: "POLICY_DENIED" });
			throw error;
		}
	}

	async exit(plan: string, signal?: AbortSignal): Promise<{ readonly approved: true }> {
		this.assertOpen();
		if (!this.get().active) throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode.`);
		if (!/^#\s+\S/.test(plan.trim()))
			throw new Error(`${EXIT_PLAN_MODE} requires a markdown plan starting with a # heading.`);
		if (!this.adapter.interaction) throw new Error("Plan review is unavailable without a user interaction channel.");
		const result = await this.adapter.interaction.request(
			{
				kind: "choice",
				prompt: "Approve this plan and leave plan mode?",
				options: [
					{ value: "approve", label: "Approve" },
					{ value: "keep", label: "Keep planning" },
				],
				questions: [
					{
						id: "plan-review",
						prompt: plan,
						options: [
							{ value: "approve", label: "Approve" },
							{ value: "keep", label: "Keep planning" },
						],
					},
				],
				intent: "plan-review",
			},
			signal,
		);
		if (result.status !== "answered" || result.value !== "approve") {
			if (result.status === "cancelled") throw new Error("The user cancelled plan review; remain in plan mode.");
			throw new Error(
				result.feedback?.trim()
					? `The user chose to keep planning; feedback: ${result.feedback}`
					: "The user chose to keep planning; revise the plan and present it again.",
			);
		}
		this.pending = { active: false, narrate: false };
		await this.preStep(signal);
		return { approved: true };
	}

	createExitTool(): AgentTool<typeof exitParameters, AgentToolResult> {
		return {
			name: EXIT_PLAN_MODE,
			description: "Present the complete Markdown plan for review. Use only in plan mode.",
			parameters: exitParameters,
			execute: async (_toolCallId, parameters, signal): Promise<ToolResultContent[]> => {
				await this.exit(parameters.plan, signal);
				return [{ type: "text", text: "Plan approved; plan mode exited." }];
			},
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = undefined;
		this.unregisterSection?.();
		this.unregisterSection = undefined;
	}

	private async commitSelection(active: boolean): Promise<void> {
		try {
			await this.adapter.appendEvent(selectionEvent(active));
			if (this.adapter.isBusy?.()) {
				this.pending = { active, narrate: true };
				return;
			}
			await this.adapter.appendEvent(modeEvent(active));
			this.pending = undefined;
		} catch {
			this.pending = { active, narrate: true };
		}
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error("Plan mode controller is disposed.");
	}
}

/** Wraps a SessionToolPolicy so plan restrictions remain enforced at execution time. */
export function createPlanToolPolicy(base: SessionToolPolicy, controller: PlanModeController): SessionToolPolicy {
	return {
		snapshot: base.snapshot,
		setMode: base.setMode,
		authorize: async (toolName, parameters, context) => {
			controller.authorize(toolName);
			await base.authorize(toolName, parameters, context);
		},
	};
}

export interface PlanModePlugin {
	readonly apiVersion: typeof PLAN_MODE_API_VERSION;
	readonly name: "plan-mode";
	readonly createController: (adapter: PlanModeAdapter) => PlanModeController;
}

export function createPlanModePlugin(config: PlanModeConfig): PlanModePlugin {
	const validated = validateConfig(config);
	return {
		apiVersion: PLAN_MODE_API_VERSION,
		name: "plan-mode",
		createController: (adapter) => new PlanModeController(adapter, validated),
	};
}

export const planMode = createPlanModePlugin({
	section: "You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.",
});
