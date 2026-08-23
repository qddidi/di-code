import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { createRootContext } from "@di-code/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustManager } from "../src/extensions/trust.ts";
import { runMain } from "../src/legacy-main.ts";
import {
	addMcpConfig,
	getMcpConfig,
	listMcpConfig,
	loadEffectiveMcpConfig,
	loadMcpConfig,
	removeMcpConfig,
} from "../src/mcp/config.ts";
import {
	mcpClient,
	mcpClientServiceKey,
	mcpConfig,
	mcpConfigServiceKey,
	mcpToolServiceKey,
	mcpTools,
} from "../src/mcp/entries.ts";

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
	it("registers config, client, and tool services without creating another Agent loop", async () => {
		const context = createRootContext({ id: "mcp-entries" });
		try {
			await context.plugin(mcpConfig, undefined);
			await context.plugin(mcpClient, undefined);
			await context.plugin(mcpTools, undefined);
			expect(context.require(mcpConfigServiceKey).load).toBe(loadEffectiveMcpConfig);
			expect(typeof context.require(mcpClientServiceKey).connect).toBe("function");
			expect(typeof context.require(mcpToolServiceKey).create).toBe("function");
		} finally {
			await context.dispose();
		}
	});

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

	it("parses Streamable HTTP headers and rejects missing or non-http URLs", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-http-config-"));
		roots.push(root);
		const reference = "$" + "{MCP_TOKEN}";
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: `Bearer ${reference}` } },
				},
			}),
		);
		await expect(loadMcpConfig(root, { MCP_TOKEN: "secret-value" })).resolves.toMatchObject([
			{
				id: "remote",
				transport: {
					type: "streamable-http",
					url: "https://example.test/mcp",
					headers: { Authorization: "Bearer secret-value" },
				},
			},
		]);
		await expect(loadMcpConfig(root, {})).rejects.toThrow('environment variable "MCP_TOKEN" is not set');
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { remote: { type: "http", url: "ftp://example.test/mcp" } } }),
		);
		await expect(loadMcpConfig(root)).rejects.toThrow("must use http or https");
	});

	it("manages local, project, and user scopes with whole-entry precedence and redacted listings", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-scopes-"));
		const home = await mkdtemp(join(tmpdir(), "di-code-mcp-home-"));
		roots.push(root, home);
		const token = "$" + "{TOKEN}";
		await addMcpConfig(
			root,
			"user",
			"shared",
			{ type: "http", url: "https://user.example/mcp", headers: { Authorization: token } },
			{ homeDirectory: home, environment: { TOKEN: "user-secret" } },
		);
		await addMcpConfig(root, "project", "shared", { command: process.execPath }, { homeDirectory: home });
		await addMcpConfig(root, "local", "local-only", { command: process.execPath }, { homeDirectory: home });
		await expect(
			loadEffectiveMcpConfig({ cwd: root, homeDirectory: home, projectTrusted: true }),
		).resolves.toMatchObject([
			{ id: "local-only", transport: { type: "stdio" } },
			{ id: "shared", transport: { type: "stdio" } },
		]);
		await expect(
			loadEffectiveMcpConfig({
				cwd: root,
				homeDirectory: home,
				projectTrusted: false,
				environment: { TOKEN: "user-secret" },
			}),
		).resolves.toMatchObject([
			{ id: "shared", transport: { type: "streamable-http", url: "https://user.example/mcp" } },
		]);
		await expect(listMcpConfig(root, "user", home)).resolves.toEqual([
			{
				id: "shared",
				scope: "user",
				config: { type: "http", url: "https://user.example/mcp", headers: { Authorization: token } },
			},
		]);
		await expect(getMcpConfig(root, "shared", undefined, home)).resolves.toMatchObject({ scope: "project" });
		await removeMcpConfig(root, "local", "local-only", home);
		await expect(getMcpConfig(root, "local-only", undefined, home)).resolves.toBeUndefined();
	});

	it("runs mcp add/list/get/remove without requiring Provider configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-cli-"));
		const agentDir = await mkdtemp(join(tmpdir(), "di-code-mcp-cli-agent-"));
		roots.push(root, agentDir);
		await new ProjectTrustManager(join(agentDir, "trust.json")).set(root, true);
		const stdout = vi.fn();
		const stderr = vi.fn();
		const base = {
			stdout,
			stderr,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: vi.fn(async () => undefined),
		};
		await expect(
			runMain(["mcp", "add", "--scope", "project", "--transport", "http", "remote", "https://example.test/mcp"], base),
		).resolves.toBe(0);
		await expect(runMain(["mcp", "get", "remote"], base)).resolves.toBe(0);
		await expect(runMain(["mcp", "list", "--scope", "project"], base)).resolves.toBe(0);
		await expect(runMain(["mcp", "remove", "remote", "--scope", "project"], base)).resolves.toBe(0);
		expect(stderr).not.toHaveBeenCalled();
		expect(stdout.mock.calls.join("\n")).toContain('"scope":"project"');
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

	it("exposes MCP resources and prompts only through explicit Agent tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-mcp-capabilities-"));
		roots.push(root);
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
		);
		const stdout = vi.fn();
		const exitCode = await runMain(["--trust-project", "--print", "read MCP resource"], {
			stdout,
			stderr: vi.fn(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir: join(root, "agent"),
			createRuntime: runtime([
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "resource-call",
							name: "mcp__fixture__resource_read",
							arguments: { uri: "fixture://hello" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Resource completed." }] },
			]),
		});
		expect(exitCode).toBe(0);
		expect(stdout).toHaveBeenCalledWith("Resource completed.\n");
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
