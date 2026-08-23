import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import {
	mcpClient,
	mcpClientServiceKey,
	mcpConfig,
	mcpTransport,
	mcpTransportRegistryKey,
} from "../src/mcp/entries.ts";

describe("MCP composition lifecycle", () => {
	it("owns connected managers by Fiber and makes explicit close idempotent", async () => {
		const context = createRootContext({ id: "mcp-lifecycle", trustedProject: true });
		try {
			await context.plugin(mcpConfig, undefined);
			await context.plugin(mcpTransport, undefined);
			await context.plugin(mcpClient, undefined);
			expect(context.require(mcpTransportRegistryKey).snapshot()).toEqual(["stdio", "streamable-http"]);
			const connected = await context.require(mcpClientServiceKey).connect([]);
			await context.require(mcpClientServiceKey).close(connected.manager);
			await expect(context.require(mcpClientServiceKey).close(connected.manager)).resolves.toBeUndefined();
		} finally {
			await context.dispose();
		}
	});
});
