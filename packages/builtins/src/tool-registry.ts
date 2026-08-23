import {
	ContributionRegistry,
	createServiceKey,
	type PluginDefinition,
	type RegistryOwner,
	type ToolSchema,
} from "@di-code/plugin-runtime";
import {
	createDefaultToolCapabilities,
	type RuntimeAgentTool,
	type ToolCapabilitySnapshot,
	type ToolFactory,
} from "./tool-capabilities.ts";

export interface ToolRegistry {
	readonly register: (tool: RuntimeAgentTool, owner?: RegistryOwner) => () => void;
	readonly registerFactory: (name: string, factory: ToolFactory, owner?: RegistryOwner) => () => void;
	readonly snapshot: (capabilities?: ToolCapabilitySnapshot) => readonly RuntimeAgentTool[];
}

export const toolRegistryKey = createServiceKey<ToolRegistry>("tool-registry");

export function createToolRegistry(): ToolRegistry {
	const registry = new ContributionRegistry();
	const factories = new Map<string, ToolFactory>();
	const registeredTools = new Map<string, RuntimeAgentTool>();
	const defaultCapabilities = createDefaultToolCapabilities(process.cwd());
	return {
		register(tool, owner) {
			const registryOwner = owner ?? { fiberId: "context", pluginName: "context" };
			const dispose = registry.register(
				{
					kind: "tool",
					name: tool.name,
					description: tool.description,
					schema: tool.parameters as unknown as ToolSchema,
					execute: (input, signal) => tool.execute("context", input as never, signal),
				},
				registryOwner,
			);
			registeredTools.set(tool.name, tool);
			return () => {
				if (registeredTools.get(tool.name) === tool) registeredTools.delete(tool.name);
				dispose();
			};
		},
		registerFactory(name, factory) {
			if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`);
			if (factories.has(name)) throw new Error(`Reserved tool name: ${name}`);
			factories.set(name, factory);
			return () => {
				if (factories.get(name) === factory) factories.delete(name);
			};
		},
		snapshot: (capabilities = defaultCapabilities) => {
			const staticTools = registry.list("tool").flatMap((entry) => {
				const tool = registeredTools.get(entry.value.name);
				return tool === undefined ? [] : [tool];
			});
			const factoryTools = [...factories.values()].flatMap((factory) => {
				const tool = factory(capabilities);
				return tool === undefined ? [] : [tool];
			});
			const tools = [...staticTools, ...factoryTools].sort((left, right) => left.name.localeCompare(right.name));
			const names = new Set<string>();
			for (const tool of tools) {
				if (names.has(tool.name)) throw new Error(`Duplicate tool registration: ${tool.name}`);
				names.add(tool.name);
			}
			return Object.freeze(
				tools.map((tool) => ({
					...tool,
					execute: async (toolCallId: string, parameters: never, signal?: AbortSignal) => {
						await capabilities.policy.authorize(tool.name, parameters, signal);
						await capabilities.approval.request(tool.name, parameters, signal);
						return capabilities.output.present(await tool.execute(toolCallId, parameters, signal));
					},
				})),
			);
		},
	};
}

export const toolRegistry: PluginDefinition = {
	apiVersion: 1,
	name: "tool-registry",
	version: "0.1.7",
	apply(context) {
		context.set(toolRegistryKey, createToolRegistry());
	},
};

export const apiVersion = toolRegistry.apiVersion;
export const name = toolRegistry.name;
export const version = toolRegistry.version;
export const apply = toolRegistry.apply;
