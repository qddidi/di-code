/** Minimal manifest-based plugin example. */
export default function helloPlugin(api) {
	api.registerCommand({
		name: "hello",
		description: "Record a greeting",
		handler: async () => {},
	});
	api.registerTool({
		name: "hello__project-name",
		description: "Return the current project directory name",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_toolCallId, _parameters) => [{ type: "text", text: process.cwd() }],
	});
}
