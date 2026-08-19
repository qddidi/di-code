import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpManager, StdioMcpClient, StreamableHttpMcpClient } from "../src/index.ts";
import { compileMcpInputSchema } from "../src/schema.ts";

const fixture = fileURLToPath(new URL("./fixture-server.mjs", import.meta.url));

describe("StdioMcpClient", () => {
	it("accepts JSON Schema 2020-12 input schemas", () => {
		const validate = compileMcpInputSchema("fixture", "browser_close", {
			type: "object",
			properties: {},
			$schema: "https://json-schema.org/draft/2020-12/schema",
			additionalProperties: false,
		});
		expect(() => validate({})).not.toThrow();
	});

	it("initializes a server, lists tools, calls a tool, and closes idempotently", async () => {
		const client = new StdioMcpClient({
			id: "fixture",
			transport: { type: "stdio", command: process.execPath, args: [fixture] },
		});
		await client.connect();
		await expect(client.listTools()).resolves.toEqual([
			expect.objectContaining({
				serverId: "fixture",
				name: "echo",
				inputSchema: expect.objectContaining({ type: "object" }),
			}),
		]);
		await expect(client.callTool("echo", { value: "hello" })).resolves.toMatchObject({
			isError: false,
			content: [{ type: "text", text: "echo:hello" }],
		});
		await expect(client.listResources()).resolves.toEqual([
			expect.objectContaining({ uri: "fixture://hello", serverId: "fixture" }),
			expect.objectContaining({ uri: "fixture://second", serverId: "fixture" }),
		]);
		await expect(client.readResource("fixture://hello")).resolves.toEqual([
			{ uri: "fixture://hello", text: "resource:fixture://hello" },
		]);
		await expect(client.listPrompts()).resolves.toEqual([
			expect.objectContaining({ name: "greet", serverId: "fixture" }),
		]);
		await expect(client.getPrompt("greet", { name: "Ada" })).resolves.toMatchObject({
			messages: [{ role: "user", content: { type: "text", text: "Hello Ada" } }],
		});
		await client.close();
		await client.close();
		await expect(client.listTools()).rejects.toThrow("not connected");
	});
});

describe("McpManager", () => {
	it("reports loading and capability counts while connecting a Server", async () => {
		const statuses: unknown[] = [];
		const manager = new McpManager({ onServerConnectionStatus: (status) => statuses.push(status) });
		try {
			const result = await manager.connect([
				{ id: "fixture", transport: { type: "stdio", command: process.execPath, args: [fixture] } },
			]);
			expect(result.servers.map((server) => server.config.id)).toEqual(["fixture"]);
			expect(statuses).toEqual([
				{ serverId: "fixture", state: "connecting" },
				{ serverId: "fixture", state: "connected", tools: 1, resources: 2, prompts: 1 },
			]);
		} finally {
			await manager.close();
		}
	});

	it("reports a redacted failure without preventing other Server connections", async () => {
		const statuses: unknown[] = [];
		const manager = new McpManager({ onServerConnectionStatus: (status) => statuses.push(status) });
		try {
			const result = await manager.connect([
				{ id: "missing", transport: { type: "stdio", command: "missing-mcp-command" } },
				{ id: "fixture", transport: { type: "stdio", command: process.execPath, args: [fixture] } },
			]);
			expect(result.servers.map((server) => server.config.id)).toEqual(["fixture"]);
			expect(statuses).toContainEqual({ serverId: "missing", state: "connecting" });
			expect(statuses).toContainEqual(
				expect.objectContaining({ serverId: "missing", state: "failed", stage: "connect" }),
			);
			expect(statuses).toContainEqual({ serverId: "fixture", state: "connected", tools: 1, resources: 2, prompts: 1 });
		} finally {
			await manager.close();
		}
	});
});

describe("StreamableHttpMcpClient", () => {
	it("connects, lists tools, forwards headers, calls a tool, and closes", async () => {
		const requests: { authorization?: string }[] = [];
		const server = createServer((request, response) => {
			requests.push({ authorization: request.headers.authorization });
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				if (body.trim() === "") {
					response.writeHead(202).end();
					return;
				}
				const message = JSON.parse(body) as { id?: number; method?: string };
				if (message.id === undefined) {
					response.writeHead(202).end();
					return;
				}
				const result =
					message.method === "initialize"
						? {
								protocolVersion: "2025-06-18",
								capabilities: { tools: {} },
								serverInfo: { name: "fixture", version: "1" },
							}
						: message.method === "tools/list"
							? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
							: { content: [{ type: "text", text: "ok" }] };
				response
					.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
					.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("server did not start");
		const client = new StreamableHttpMcpClient({
			id: "remote",
			transport: {
				type: "streamable-http",
				url: `http://127.0.0.1:${address.port}/mcp`,
				headers: { Authorization: "Bearer test" },
			},
		});
		try {
			await client.connect();
			await expect(client.listTools()).resolves.toMatchObject([{ name: "echo", serverId: "remote" }]);
			await expect(client.callTool("echo", {})).resolves.toMatchObject({
				isError: false,
				content: [{ type: "text", text: "ok" }],
			});
			expect(requests.every((entry) => entry.authorization === "Bearer test")).toBe(true);
		} finally {
			await client.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
