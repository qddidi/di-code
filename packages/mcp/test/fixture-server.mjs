import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "di-code-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echo one required value.",
			inputSchema: {
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
		},
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name !== "echo") return { content: [{ type: "text", text: "unknown tool" }], isError: true };
	return { content: [{ type: "text", text: `echo:${request.params.arguments?.value}` }] };
});
await server.connect(new StdioServerTransport());
