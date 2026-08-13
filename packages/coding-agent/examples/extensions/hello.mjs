/**
 * Minimal extension example. It intentionally uses only the package root API.
 */
export default function helloExtension(api) {
	api.registerCommand({
		name: "hello",
		description: "Record a greeting",
		handler: async (ctx) => {
			ctx.abort();
		},
	});
	api.registerTool({
		name: "project-name",
		description: "Return the current project directory name",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_toolCallId, _parameters, _signal, ctx) => [{ type: "text", text: ctx.cwd }],
	});
	api.on("agent_end", (_event, ctx) => {
		void ctx.isProjectTrusted();
	});
}
