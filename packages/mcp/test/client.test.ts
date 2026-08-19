import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StdioMcpClient } from "../src/index.ts";

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
