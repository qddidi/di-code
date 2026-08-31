/** Minimal Pi-style di-code extension. */
export default function setup(api) {
	api.registerCommand({
		name: "hello",
		description: "Say hello",
		run: async () => ({ version: 1, text: "Hello from an extension" }),
	});
	api.registerTool({
		name: "echo",
		description: "Echo structured input",
		schema: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
		execute: async (input) => ({ version: 1, content: input.parameters, truncated: false }),
	});
	api.registerSubagent({ name: "helper", description: "Run a host-managed child task", run: async (input) => ({ version: 1, taskId: "template" , text: input.prompt }) });
	api.registerTuiOverlay({ name: "hello-overlay", render: () => ["Hello overlay"] });
	api.registerWeb({ entry: "./web.js", integrity: "sha256-REPLACE_AFTER_PACKAGING", slots: ["app.sidebar"] });
}
