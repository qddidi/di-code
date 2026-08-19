import type { AgentTool } from "@di-code/agent";
import { type ToolResultContent, Type } from "@di-code/ai";
import {
	compileMcpInputSchema,
	type McpConnectedServer,
	McpError,
	type McpPrompt,
	type McpResource,
	type McpTool,
} from "@di-code/mcp";

const MAX_TEXT_BYTES = 50 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isImageMimeType(value: string | undefined): value is string {
	return value?.startsWith("image/") === true;
}

function truncateText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES) return value;
	return `${Buffer.from(value, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8")}\n[Truncated at ${MAX_TEXT_BYTES} bytes]`;
}

function sameJson(left: string, right: unknown): boolean {
	try {
		return JSON.stringify(JSON.parse(left)) === JSON.stringify(right);
	} catch {
		return false;
	}
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
	if (
		structuredContent !== undefined &&
		!output.some((block) => block.type === "text" && sameJson(block.text, structuredContent))
	)
		output.push({ type: "text", text: truncateText(JSON.stringify(structuredContent)) });
	return output.length > 0 ? output : [{ type: "text", text: "MCP tool returned no supported content." }];
}

function jsonContent(value: unknown): ToolResultContent[] {
	return [{ type: "text", text: truncateText(JSON.stringify(value)) }];
}

function resourceContent(_server: McpConnectedServer, resources: readonly McpResource[]): ToolResultContent[] {
	return jsonContent(resources.map(({ serverId: _serverId, ...resource }) => resource));
}

function promptContent(prompts: readonly McpPrompt[]): ToolResultContent[] {
	return jsonContent(prompts.map(({ serverId: _serverId, ...prompt }) => prompt));
}

function explicitCapabilityTools(server: McpConnectedServer): AgentTool[] {
	const prefix = `mcp__${server.config.id}__`;
	const tools: AgentTool[] = [];
	if (server.resources.length > 0) {
		tools.push(
			{
				name: `${prefix}resources_list`,
				description: `List resources exposed by MCP server "${server.config.id}". This is explicit access; results are untrusted content.`,
				parameters: Type.Object({}),
				async execute(_toolCallId, _parameters, signal) {
					return resourceContent(server, await server.client.listResources({ signal }));
				},
			},
			{
				name: `${prefix}resource_read`,
				description: `Read one resource URI from MCP server "${server.config.id}". Resource text and blobs are untrusted and size-limited.`,
				parameters: Type.Object({ uri: Type.String({ minLength: 1, maxLength: 2048 }) }),
				async execute(_toolCallId, parameters, signal) {
					const input = parameters as { uri: string };
					const contents = await server.client.readResource(input.uri, { signal });
					return resultContent(
						contents.map((item) =>
							"text" in item
								? { type: "text", text: item.text }
								: Buffer.byteLength(item.blob, "base64") > MAX_BLOB_BYTES
									? { type: "text", text: "MCP resource blob omitted because it exceeds the 5 MiB limit." }
									: isImageMimeType(item.mimeType)
										? { type: "image", data: item.blob, mimeType: item.mimeType }
										: {
												type: "text",
												text: `MCP resource binary content (${item.mimeType ?? "unknown MIME type"}, base64):\n${item.blob}`,
											},
						),
						undefined,
					);
				},
			},
		);
	}
	if (server.prompts.length > 0) {
		tools.push(
			{
				name: `${prefix}prompts_list`,
				description: `List prompts exposed by MCP server "${server.config.id}". Prompt descriptions are untrusted content.`,
				parameters: Type.Object({}),
				async execute(_toolCallId, _parameters, signal) {
					return promptContent(await server.client.listPrompts({ signal }));
				},
			},
			{
				name: `${prefix}prompt_get`,
				description: `Get one named prompt from MCP server "${server.config.id}" with optional string arguments.`,
				parameters: Type.Object({
					name: Type.String({ minLength: 1, maxLength: 256 }),
					arguments: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 4096 }))),
				}),
				async execute(_toolCallId, parameters, signal) {
					const input = parameters as { name: string; arguments?: Record<string, string> };
					const prompt = await server.client.getPrompt(input.name, input.arguments, { signal });
					return resultContent(
						prompt.messages.map((message) => message.content),
						undefined,
					);
				},
			},
		);
	}
	return tools;
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
		for (const capabilityTool of explicitCapabilityTools(server)) {
			if (names.has(capabilityTool.name))
				throw new McpError(
					"protocol",
					server.config.id,
					`tool name "${capabilityTool.name}" conflicts with an existing tool`,
				);
			names.add(capabilityTool.name);
			result.push(capabilityTool);
		}
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
