import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "di-code-fixture", version: "1.0.0" },
	{ capabilities: { tools: {}, resources: { listChanged: true }, prompts: { listChanged: true } } },
);
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
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
	if (request.params.cursor === undefined)
		return { resources: [{ uri: "fixture://hello", name: "hello", mimeType: "text/plain" }], nextCursor: "page-2" };
	return { resources: [{ uri: "fixture://second", name: "second", mimeType: "text/plain" }] };
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
	contents: [{ uri: request.params.uri, text: `resource:${request.params.uri}` }],
}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
	prompts: [{ name: "greet", description: "Greeting prompt", arguments: [{ name: "name", required: true }] }],
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
	description: "Fixture prompt",
	messages: [{ role: "user", content: { type: "text", text: `Hello ${request.params.arguments?.name ?? "world"}` } }],
}));
await server.connect(new StdioServerTransport());
