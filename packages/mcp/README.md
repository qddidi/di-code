# @di-code/mcp

`@di-code/mcp` is the MCP client lifecycle package used by di-code. It implements MCP SDK `1.30.0` over local `stdio` and remote Streamable HTTP transports.

The package owns connection initialization, `tools/list`, `tools/call`, timeouts, cancellation propagation and idempotent cleanup. It does not implement an Agent loop or make tool authorization decisions. Hosts must validate project configuration and trust before constructing a manager.

```ts
import { McpManager } from "@di-code/mcp";

const manager = new McpManager();
const { servers } = await manager.connect([
	{ id: "project-tools", transport: { type: "stdio", command: "node", args: ["server.mjs"] } },
	{ id: "company-api", transport: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${COMPANY_MCP_TOKEN}" } } },
]);

try {
	await servers[0]?.client.callTool("status", {});
} finally {
	await manager.close();
}
```

`McpError` distinguishes connection, authentication, protocol, timeout, cancellation, tool and closed-client failures. Server output is untrusted; diagnostics are redacted and capped at 4 KiB.

Streamable HTTP URLs must be absolute `http` or `https` URLs. Headers should use environment references in host configuration; the package never persists or logs them.
