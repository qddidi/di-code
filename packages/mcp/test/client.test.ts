import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StdioMcpClient, StreamableHttpMcpClient } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixture-server.mjs", import.meta.url));

describe("StdioMcpClient", () => {
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
		await client.close();
		await client.close();
		await expect(client.listTools()).rejects.toThrow("not connected");
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
