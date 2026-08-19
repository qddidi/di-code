import type { AgentTool } from "@di-code/agent";
import { type ToolResultContent, Type } from "@di-code/ai";
import { compileMcpInputSchema, type McpConnectedServer, McpError, type McpTool } from "@di-code/mcp";

const MAX_TEXT_BYTES = 50 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function truncateText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES) return value;
	return `${Buffer.from(value, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8")}\n[Truncated at ${MAX_TEXT_BYTES} bytes]`;
}

function resultContent(content: readonly unknown[], structuredContent: unknown): ToolResultContent[] {
	const output: ToolResultContent[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string")
			output.push({ type: "text", text: truncateText(block.text) });
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			if (Buffer.byteLength(block.data, "base64") <= MAX_IMAGE_BYTES)
				output.push({ type: "image", data: block.data, mimeType: block.mimeType });
			else output.push({ type: "text", text: "MCP tool image result was omitted because it exceeds the 5 MiB limit." });
		}
	}
	if (structuredContent !== undefined)
		output.push({ type: "text", text: truncateText(JSON.stringify(structuredContent)) });
	return output.length > 0 ? output : [{ type: "text", text: "MCP tool returned no supported content." }];
}

function adaptTool(server: McpConnectedServer, tool: McpTool): AgentTool {
	const name = `mcp__${server.config.id}__${tool.name}`;
	if (!TOOL_NAME_PATTERN.test(tool.name) || name.length > 128) {
		throw new McpError("protocol", server.config.id, `tool name "${tool.name}" cannot be exposed safely`);
	}
	const validate = compileMcpInputSchema(server.config.id, tool.name, tool.inputSchema);
	return {
		name,
		description: tool.description?.trim() || `Tool "${tool.name}" provided by MCP server "${server.config.id}".`,
		// Providers receive the original JSON Schema; Ajv validates the model input before forwarding it.
		parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			validate(parameters);
			const result = await server.client.callTool(tool.name, parameters as Record<string, unknown>, signal);
			const content = resultContent(result.content, result.structuredContent);
			if (result.isError)
				throw new McpError(
					"tool",
					server.config.id,
					content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n"),
				);
			return content;
		},
	};
}

/** Converts connected MCP tools to AgentTool values and rejects every namespace collision before registration. */
export function createMcpAgentTools(
	servers: readonly McpConnectedServer[],
	reservedNames: Iterable<string> = [],
): readonly AgentTool[] {
	const names = new Set(reservedNames);
	const result: AgentTool[] = [];
	for (const server of servers) {
		for (const tool of server.tools) {
			const adapted = adaptTool(server, tool);
			if (names.has(adapted.name))
				throw new McpError("protocol", server.config.id, `tool name "${adapted.name}" conflicts with an existing tool`);
			names.add(adapted.name);
			result.push(adapted);
		}
	}
	return result;
}
