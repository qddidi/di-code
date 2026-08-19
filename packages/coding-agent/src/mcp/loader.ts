import {
	type McpDiagnostic,
	McpManager,
	type McpServerConfig,
	type McpServerConnectionStatus,
	redactMcpDiagnostic,
} from "@di-code/mcp";
import { loadEffectiveMcpConfig, mcpConfigPath, readMcpConfigScope } from "./config.ts";
import { createMcpAgentTools } from "./tool-adapter.ts";

export interface McpLoadDiagnostic {
	readonly serverId?: string;
	readonly stage: "config" | "trust" | McpDiagnostic["stage"];
	readonly message: string;
}

export interface McpLoadResult {
	readonly manager: McpManager;
	readonly tools: ReturnType<typeof createMcpAgentTools>;
	readonly diagnostics: readonly McpLoadDiagnostic[];
}

/** Loads trusted project MCP servers. A failed server is isolated from all other tools. */
export async function loadProjectMcp(options: {
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly reservedToolNames: Iterable<string>;
	readonly homeDirectory?: string;
	readonly onServerConnectionStatus?: (status: McpServerConnectionStatus) => void;
}): Promise<McpLoadResult> {
	const manager = new McpManager({ onServerConnectionStatus: options.onServerConnectionStatus });
	if (!options.projectTrusted) {
		try {
			const [local, project] = await Promise.all([
				readMcpConfigScope(options.cwd, "local", options.homeDirectory),
				readMcpConfigScope(options.cwd, "project", options.homeDirectory),
			]);
			const projectDiagnostic =
				Object.keys(local.mcpServers).length > 0 || Object.keys(project.mcpServers).length > 0
					? {
							stage: "trust" as const,
							message: `${mcpConfigPath(options.cwd, "project", options.homeDirectory)} was skipped because project trust is not granted`,
						}
					: undefined;
			const userConfigurations = await loadEffectiveMcpConfig({
				cwd: options.cwd,
				projectTrusted: false,
				homeDirectory: options.homeDirectory,
			});
			const connected = await manager.connect(userConfigurations);
			return {
				manager,
				tools: createMcpAgentTools(connected.servers, options.reservedToolNames),
				diagnostics: [...(projectDiagnostic ? [projectDiagnostic] : []), ...connected.diagnostics],
			};
		} catch (cause) {
			await manager.close();
			return { manager, tools: [], diagnostics: [{ stage: "config", message: redactMcpDiagnostic(cause) }] };
		}
	}
	let configurations: readonly McpServerConfig[];
	try {
		configurations = await loadEffectiveMcpConfig({
			cwd: options.cwd,
			projectTrusted: true,
			homeDirectory: options.homeDirectory,
		});
	} catch (cause) {
		return { manager, tools: [], diagnostics: [{ stage: "config", message: redactMcpDiagnostic(cause) }] };
	}
	const connected = await manager.connect(configurations);
	try {
		return {
			manager,
			tools: createMcpAgentTools(connected.servers, options.reservedToolNames),
			diagnostics: connected.diagnostics,
		};
	} catch (cause) {
		await manager.close();
		return { manager, tools: [], diagnostics: [{ stage: "list_tools", message: redactMcpDiagnostic(cause) }] };
	}
}
