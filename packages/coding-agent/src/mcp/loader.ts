import { type McpDiagnostic, McpManager, type McpServerConfig, redactMcpDiagnostic } from "@di-code/mcp";
import { loadMcpConfig, mcpConfigPath } from "./config.ts";
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
}): Promise<McpLoadResult> {
	const manager = new McpManager();
	if (!options.projectTrusted) {
		try {
			const configured = await loadMcpConfig(options.cwd);
			if (configured.length > 0) {
				return {
					manager,
					tools: [],
					diagnostics: [
						{
							stage: "trust",
							message: `${mcpConfigPath(options.cwd)} was skipped because project trust is not granted`,
						},
					],
				};
			}
		} catch (cause) {
			return { manager, tools: [], diagnostics: [{ stage: "config", message: redactMcpDiagnostic(cause) }] };
		}
		return { manager, tools: [], diagnostics: [] };
	}
	let configurations: readonly McpServerConfig[];
	try {
		configurations = await loadMcpConfig(options.cwd);
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
