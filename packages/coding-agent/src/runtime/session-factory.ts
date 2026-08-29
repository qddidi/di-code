import { createPromptSectionRegistry } from "@di-code/agent";
import {
	agentSessionKey,
	compactionRegistryKey,
	createSessionToolPolicy,
	imageGenerationCapabilityKey,
	networkCapabilityKey,
	processCapabilityKey,
	promptRegistryKey,
	TOOL_POLICY_EVENT_NAME,
	TOOL_POLICY_EVENT_NAMESPACE,
	TOOL_POLICY_EVENT_SCHEMA_VERSION,
	type ToolApprovalCapability,
	type ToolPolicyCapability,
	type ToolPolicyMode,
	toolApprovalKey,
	toolOutputKey,
	toolRegistryKey,
	workspaceCapabilityKey,
} from "@di-code/builtins";
import { createPlanModePlugin, type PlanModeController } from "@di-code/plan-mode";
import { type Context, createServiceKey, type Disposer } from "@di-code/plugin-runtime";
import {
	createSessionPluginRegistry,
	type SessionPluginFactory,
	type SessionPluginScope,
	sessionPluginRegistryKey,
	type UserInteraction,
} from "@di-code/plugin-sdk";
import { createSkillCatalog } from "@di-code/skills";
import type { SkillResource } from "../core/resources/types.ts";
import { AgentSession, type AgentSessionOptions, type AgentSessionTool } from "../core/session.ts";

export interface CompositionSessionOptions extends Omit<AgentSessionOptions, "tools" | "skills" | "planMode"> {
	readonly skills?: readonly SkillResource[];
	/** MCP tools already adapted by the product integration layer. */
	readonly externalTools?: readonly AgentSessionTool[];
	/** Per-session approval boundary; defaults to the composition capability. */
	readonly toolApproval?: ToolApprovalCapability;
	/** Optional policy override; otherwise a durable Session policy is created. */
	readonly toolPolicy?: ToolPolicyCapability;
	/** Read-only state supplied to the Session policy at each authorization boundary. */
	readonly getToolPolicyProjection?: () => unknown;
	readonly getToolPolicyPluginState?: () => unknown;
	/** Optional structured interaction surface used by session-scoped tools. */
	readonly interaction?: UserInteraction;
	/** Session-scoped plugin factories. Each binding receives an isolated public scope. */
	readonly sessionPlugins?: readonly { readonly factory: SessionPluginFactory<unknown>; readonly config: unknown }[];
	readonly planMode?: { readonly section: string };
}

interface SessionDependencies {
	readonly tools: readonly AgentSessionTool[];
}

const sessionDependenciesKey = createServiceKey<SessionDependencies>("session-dependencies");

function asCompositionSessionOptions(value: unknown): CompositionSessionOptions {
	if (typeof value !== "object" || value === null) throw new TypeError("AgentSessionFactory options must be an object");
	return value as CompositionSessionOptions;
}

function persistedPolicyMode(manager: import("../core/session/session-manager.ts").SessionManager): ToolPolicyMode {
	for (const entry of [...manager.getBranch()].reverse()) {
		if (
			entry.type !== "event" ||
			entry.namespace !== TOOL_POLICY_EVENT_NAMESPACE ||
			entry.eventName !== TOOL_POLICY_EVENT_NAME ||
			entry.schemaVersion !== TOOL_POLICY_EVENT_SCHEMA_VERSION
		)
			continue;
		const payload = entry.payload;
		if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
			const mode = (payload as { readonly mode?: unknown }).mode;
			if (mode === "normal" || mode === "read_only") return mode;
		}
	}
	return "normal";
}

/**
 * Installs the product AgentSession implementation behind the composition factory.
 * Each session receives an isolated Context and immutable tool snapshot; the factory disposer releases all scopes.
 */
export function installAgentSessionFactory(context: Context): Disposer {
	const factory = context.require(agentSessionKey);
	const sessionContexts = new Set<Context>();
	const sessionScopes = new Set<readonly SessionPluginScope[]>();
	const sessionPluginRegistry = createSessionPluginRegistry();
	const unregisterRegistry = context.set(sessionPluginRegistryKey, sessionPluginRegistry);
	let nextSessionId = 0;

	const unregister = factory.register(async (input) => {
		const options = asCompositionSessionOptions(input);
		const workspace = { ...context.require(workspaceCapabilityKey), allowedRoot: options.allowedRoot };
		const skillCatalog = createSkillCatalog(
			(options.skills ?? []).map((skill) => ({
				skill: {
					...skill,
					source:
						skill.source ?? (skill.scope === "explicit" ? "explicit" : skill.scope === "project" ? "project" : "user"),
					userInvocable: skill.userInvocable ?? true,
				},
				diagnostics: [],
			})),
		);
		const compaction = context
			.require(compactionRegistryKey)
			.snapshot()
			.find((entry) => entry.name === "tool-result");
		const prepareMessages = compaction
			? async (messages: readonly import("@di-code/ai").Message[], signal?: AbortSignal) => {
					const result = await compaction.compact({ messages }, signal);
					if (
						typeof result !== "object" ||
						result === null ||
						!Array.isArray((result as { readonly messages?: unknown }).messages)
					)
						throw new TypeError("tool-result compaction contribution must return { messages }");
					return (result as { readonly messages: readonly import("@di-code/ai").Message[] }).messages;
				}
			: undefined;
		const sessionContext = context.child({ id: `session-${++nextSessionId}`, isolate: true });
		sessionContexts.add(sessionContext);
		let pluginScopes: SessionPluginScope[] = [];
		const promptSections = createPromptSectionRegistry();
		const pluginSessionId = options.sessionManager?.header.id ?? sessionContext.id;
		const policy =
			options.toolPolicy ??
			createSessionToolPolicy({
				sessionId: pluginSessionId,
				initialMode: options.sessionManager ? persistedPolicyMode(options.sessionManager) : "normal",
				projection: options.getToolPolicyProjection,
				pluginState: options.getToolPolicyPluginState,
				persistMode: async (mode, signal) => {
					if (!options.sessionManager) return;
					await options.sessionManager.appendEvent({
						namespace: TOOL_POLICY_EVENT_NAMESPACE,
						eventName: TOOL_POLICY_EVENT_NAME,
						schemaVersion: TOOL_POLICY_EVENT_SCHEMA_VERSION,
						payload: { mode },
						signal,
					});
				},
			});
		const approval = options.toolApproval ?? context.require(toolApprovalKey);
		let session: AgentSession | undefined;
		let planMode: PlanModeController | undefined;
		if (options.planMode) {
			const manager = options.sessionManager;
			const events = () =>
				manager
					?.getBranch()
					.filter((entry) => entry.type === "event")
					.map((entry) => ({
						namespace: entry.namespace,
						eventName: entry.eventName,
						schemaVersion: entry.schemaVersion,
						payload: entry.payload,
					})) ?? [];
			planMode = createPlanModePlugin(options.planMode).createController({
				sessionId: pluginSessionId,
				events,
				appendEvent: async (event, signal) => {
					if (!manager) return;
					await manager.appendEvent({ ...event, signal });
				},
				isBusy: () => session?.isStreaming ?? false,
				promptSections,
				interaction: options.interaction,
			});
		}
		const effectivePolicy: ToolPolicyCapability = planMode
			? {
					...policy,
					authorize: async (toolName, parameters, signal) => {
						planMode?.authorize(toolName);
						await policy.authorize(toolName, parameters, signal);
					},
				}
			: policy;
		const output = context.require(toolOutputKey);
		const tools = Object.freeze([
			...context.require(toolRegistryKey).snapshot({
				workspace,
				process: context.require(processCapabilityKey),
				network: context.require(networkCapabilityKey),
				policy: effectivePolicy,
				approval,
				output,
				imageGeneration: context.get(imageGenerationCapabilityKey),
				skills: skillCatalog,
			}),
			...(options.externalTools ?? []).map((tool) => ({
				...tool,
				execute: async (toolCallId: string, parameters: never, signal?: AbortSignal) => {
					await effectivePolicy.authorize(tool.name, parameters, signal);
					await approval.request(tool.name, parameters, signal);
					return output.present(await tool.execute(toolCallId, parameters, signal));
				},
			})),
			...(planMode ? [planMode.createExitTool()] : []),
		]);
		sessionContext.set(sessionDependenciesKey, { tools });
		try {
			for (const section of context.require(promptRegistryKey).snapshotSections?.() ?? [])
				promptSections.register(section);
			const registrations = [
				...sessionPluginRegistry.snapshot(),
				...(options.sessionPlugins ?? []).map(({ factory, config }, index) => ({
					name: `internal.${index}`,
					factory,
					config,
				})),
			];
			pluginScopes = await Promise.all(
				registrations.map(({ factory, config }) => factory.create(pluginSessionId, config)),
			);
			for (const scope of pluginScopes) {
				const removers = scope.promptSections.snapshot().map((section) => promptSections.register(section));
				scope.onDispose(() => {
					for (const remove of removers) remove();
				});
			}
			sessionScopes.add(pluginScopes);
		} catch (error) {
			await Promise.allSettled(pluginScopes.map((scope) => scope.dispose()));
			await sessionContext.dispose();
			sessionContexts.delete(sessionContext);
			throw error;
		}
		session = new AgentSession({
			...options,
			...(prepareMessages ? { compaction: { ...(options.compaction ?? {}), prepareMessages } } : {}),
			tools: sessionContext.require(sessionDependenciesKey).tools,
			promptSections,
			toolPolicy: policy,
			getPromptSnapshot: () => ({
				...(options.getPromptSnapshot?.() as object | undefined),
				sessionId: pluginSessionId,
				messageCount: options.sessionManager?.messages.length ?? 0,
				leafId: options.sessionManager?.leafId,
			}),
			onDispose: async () => {
				if (sessionScopes.has(pluginScopes)) sessionScopes.delete(pluginScopes);
				const results = await Promise.allSettled(pluginScopes.map((scope) => scope.dispose()));
				await sessionContext.dispose();
				const errors = results
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map((r) => r.reason);
				if (errors.length > 0) throw new AggregateError(errors, "Session plugin scope disposal failed");
			},
			planMode,
			hooks: planMode
				? [
						{
							kind: "modifier",
							phase: "pre_step",
							onError: "fail",
							run: async (_event, hookContext) => {
								await planMode?.preStep(hookContext.signal);
								return undefined;
							},
						},
					]
				: undefined,
		});
		return session;
	});
	return async () => {
		unregister();
		await Promise.allSettled(sessionPluginRegistry.snapshot().map((registration) => registration.factory.dispose()));
		await unregisterRegistry();
		for (const scopes of [...sessionScopes]) await Promise.allSettled(scopes.map((scope) => scope.dispose()));
		sessionScopes.clear();
		for (const sessionContext of [...sessionContexts].reverse()) await sessionContext.dispose();
		sessionContexts.clear();
	};
}
