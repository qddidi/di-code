import type { AgentContextProvider, AgentTool, AgentToolResult } from "@di-code/agent";
import type { JsonValue, TSchema } from "@di-code/ai";
import {
	type PluginCommand,
	type PluginCommandContext,
	type PluginContextProviderOptions,
	type PluginFactory,
	PluginHost,
	type PluginInteractiveFrontend,
	type PluginPromptContext,
	type PluginScope,
	type PluginUiContributions,
} from "@di-code/plugin-runtime";

export interface CodingAgentPluginHostOptions {
	readonly cwd: string;
	readonly mode: PluginPromptContext["mode"];
	readonly projectTrusted: boolean;
	readonly model?: string;
	readonly baseSystemPrompt?: string;
	readonly reservedCommands?: readonly string[];
}

/** Product adapter between the host-neutral runtime and coding-agent sessions. */
export class CodingAgentPluginHost {
	readonly runtime: PluginHost;
	private readonly options: CodingAgentPluginHostOptions;

	constructor(options: CodingAgentPluginHostOptions) {
		this.options = { ...options };
		this.runtime = new PluginHost(options);
	}

	get diagnostics() {
		return this.runtime.diagnostics;
	}

	get version(): number {
		return this.runtime.version;
	}

	async load(pluginId: string, factory: PluginFactory): Promise<PluginScope> {
		return this.runtime.load(pluginId, factory);
	}

	listTools(): readonly AgentTool<TSchema, AgentToolResult>[] {
		return [...this.runtime.snapshot().contributions.tools];
	}

	listCommands(): readonly PluginCommand[] {
		return [...this.runtime.snapshot().contributions.commands];
	}

	listPluginIds(): readonly string[] {
		return this.runtime.listPluginIds();
	}

	listInteractiveFrontends(): readonly PluginInteractiveFrontend[] {
		return [...this.runtime.snapshot().contributions.frontends];
	}

	snapshot() {
		return this.runtime.snapshot();
	}

	getUiContributions(): PluginUiContributions {
		const { panels, toolDetailRenderers } = this.runtime.snapshot().contributions;
		return { panels: [...panels], toolDetailRenderers: [...toolDetailRenderers] };
	}

	async runCommand(
		name: string,
		args: string,
		sessionId?: string,
		signal?: AbortSignal,
		notify: (message: string) => void = () => {},
	): Promise<void> {
		const command = this.listCommands().find((candidate) => candidate.name === name);
		if (!command) throw new Error(`Unknown plugin command: "${name}"`);
		const context: PluginCommandContext = {
			args,
			cwd: this.options.cwd,
			...(sessionId === undefined ? {} : { sessionId }),
			...(signal === undefined ? {} : { signal }),
			notify,
		};
		await command.handler(context);
	}

	getContextProvider(
		options: PluginContextProviderOptions & {
			readonly tools?: readonly AgentTool<TSchema, AgentToolResult>[];
		} = {},
	): AgentContextProvider {
		const pluginProvider = this.runtime.getContextProvider(options);
		return {
			resolve: async (signal) => {
				const context = await pluginProvider.resolve(signal);
				return {
					systemPrompt: context.systemPrompt,
					tools: [...(options.tools ?? []), ...context.tools],
					toolMiddleware: context.toolMiddleware,
				};
			},
		};
	}

	async emit(event: { readonly type: string } & Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		await this.runtime.emit(event.type, event, signal);
	}

	async projectSession(value: unknown): Promise<Readonly<Record<string, JsonValue>>> {
		const output: Record<string, JsonValue> = {};
		for (const projection of this.runtime.snapshot().contributions.sessionProjections) {
			const projected = await projection.project(value);
			if (!isJsonValue(projected))
				throw new Error(`Plugin session projection "${projection.id}" returned non-JSON data`);
			output[projection.id] = projected;
		}
		return output;
	}

	async dispose(): Promise<void> {
		await this.runtime.dispose();
	}
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJsonValue);
}

export function createCodingAgentPluginHost(options: CodingAgentPluginHostOptions): CodingAgentPluginHost {
	return new CodingAgentPluginHost(options);
}
