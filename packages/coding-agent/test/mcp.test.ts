import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../src/main.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";

const roots: string[] = [];
const fixture = fileURLToPath(new URL("../../mcp/test/fixture-server.mjs", import.meta.url));

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runtime(responses: readonly FauxResponse[]) {
	const faux = createFauxProvider({ responses });
	return () => ({ provider: faux.provider, model: faux.model });
}

describe("project MCP integration", () => {
	it("parses stdio configuration and resolves environment references without exposing values", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-config-"));
		roots.push(root);
		const environmentReference = "$" + "{TOKEN}";
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: "node", env: { FIXTURE_TOKEN: environmentReference } } } }),
		);
		await expect(loadMcpConfig(root, { TOKEN: "secret-value" })).resolves.toMatchObject([
			{ id: "fixture", transport: { command: "node", env: { FIXTURE_TOKEN: "secret-value" } } },
		]);
		await expect(loadMcpConfig(root, {})).rejects.toThrow('environment variable "TOKEN" is not set');
	});

	it("connects a trusted stdio server and returns its tool result through the existing Agent loop", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-main-"));
		roots.push(root);
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
		);
		const stdout = vi.fn();
		const stderr = vi.fn();
		const exitCode = await runMain(["--trust-project", "--print", "use MCP"], {
			stdout,
			stderr,
			version: "0.0.0",
			allowedRoot: root,
			agentDir: join(root, "agent"),
			createRuntime: runtime([
				{
					type: "success",
					content: [{ type: "tool_call", id: "mcp-call", name: "mcp__fixture__echo", arguments: { value: "hello" } }],
				},
				{ type: "success", content: [{ type: "text", text: "MCP completed." }] },
			]),
		});
		expect(exitCode).toBe(0);
		expect(stdout).toHaveBeenCalledWith("MCP completed.\n");
		expect(stderr).not.toHaveBeenCalled();
	});

	it("does not start project MCP servers without project trust", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-untrusted-"));
		roots.push(root);
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
		);
		const stderr = vi.fn();
		await expect(
			runMain(["--print", "hello"], {
				stdout: vi.fn(),
				stderr,
				version: "0.0.0",
				allowedRoot: root,
				agentDir: join(root, "agent"),
				createRuntime: runtime([{ type: "success", content: [{ type: "text", text: "done" }] }]),
			}),
		).resolves.toBe(0);
		expect(stderr.mock.calls.join("\n")).toContain("mcp_diagnostic");
		expect(stderr.mock.calls.join("\n")).toContain("trust");
	});

	it("includes .mcp.json in the first interactive project trust decision", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-trust-prompt-"));
		roots.push(root);
		await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
		const promptProjectTrust = vi.fn().mockResolvedValue(false);
		await expect(
			runMain(["--interactive"], {
				stdout: vi.fn(),
				stderr: vi.fn(),
				version: "0.0.0",
				allowedRoot: root,
				agentDir: join(root, "agent"),
				isInteractiveTerminal: true,
				promptProjectTrust,
				createRuntime: vi.fn(async () => undefined),
			}),
		).resolves.toBe(0);
		expect(promptProjectTrust).toHaveBeenCalledWith(root);
	});
});
