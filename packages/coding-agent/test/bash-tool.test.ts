import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Provider } from "@di-code/ai";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { type BashOperations, createBashTool, DEFAULT_BASH_TIMEOUT_MS } from "../src/core/tools/bash.ts";

const tempDirs: string[] = [];

async function createTempDir(prefix = "di-code-bash-root-"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function nodeCommand(script: string): string {
	const encoded = Buffer.from(script, "utf8").toString("base64");
	return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

function textOf(blocks: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>): string {
	return blocks
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function statusOf(text: string): Record<string, unknown> {
	const statusLine = text.split("\n").find((line) => line.startsWith("status: "));
	if (!statusLine) throw new Error("Missing bash status line");
	return JSON.parse(statusLine.slice("status: ".length)) as Record<string, unknown>;
}

function findToolResult(messages: readonly Message[], toolCallId: string) {
	const result = messages.find((message) => message.role === "tool_result" && message.toolCallId === toolCallId);
	if (!result || result.role !== "tool_result") throw new Error(`Missing tool result for ${toolCallId}`);
	return result;
}

async function waitForMissing(path: string, durationMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, durationMs));
	await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createBashTool", () => {
	it("captures stdout and stderr with a successful status", async () => {
		const root = await createTempDir();
		const result = await createBashTool(root).execute("bash-1", {
			command: nodeCommand("process.stdout.write('out');process.stderr.write('err')"),
		});
		const text = textOf(result);
		expect(text).toContain("stdout:\nout");
		expect(text).toContain("stderr:\nerr");
		expect(statusOf(text)).toEqual({
			exitCode: 0,
			timedOut: false,
			aborted: false,
			stdoutTruncated: false,
			stderrTruncated: false,
		});
	});

	it("runs in the real allowed root", async () => {
		const root = await createTempDir();
		const result = await createBashTool(root).execute("bash-cwd", {
			command: nodeCommand("process.stdout.write(process.cwd())"),
		});
		expect(textOf(result)).toContain(`stdout:\n${await realpath(root)}`);
	});

	it.runIf(process.platform === "win32")("executes a quoted Windows executable path", async () => {
		const root = await createTempDir();
		const result = await createBashTool(root).execute("bash-quoted-executable", {
			command: `"${process.execPath}" --version`,
		});
		expect(textOf(result)).toContain(`stdout:\nv${process.versions.node}`);
	});

	it("marks empty output explicitly", async () => {
		const root = await createTempDir();
		const text = textOf(await createBashTool(root).execute("bash-empty", { command: nodeCommand("") }));
		expect(text).toContain("stdout:\n(empty)");
		expect(text).toContain("stderr:\n(empty)");
	});

	it("rejects a non-zero exit with its output and exit code", async () => {
		const root = await createTempDir();
		await expect(
			createBashTool(root).execute("bash-exit", {
				command: nodeCommand("process.stderr.write('failed');process.exit(7)"),
			}),
		).rejects.toThrow(/Command exited with code 7[\s\S]*stderr:\nfailed[\s\S]*"exitCode":7/);
	});

	it("times out and reports captured output", async () => {
		const root = await createTempDir();
		await expect(
			createBashTool(root).execute("bash-timeout", {
				command: nodeCommand("process.stdout.write('started');setTimeout(function(){},10000)"),
				timeoutMs: 100,
			}),
		).rejects.toThrow(/Command timed out after 100 ms[\s\S]*stdout:\nstarted[\s\S]*"timedOut":true/);
	});

	it("aborts an in-flight command", async () => {
		const root = await createTempDir();
		const controller = new AbortController();
		const operation = createBashTool(root).execute(
			"bash-abort",
			{ command: nodeCommand("process.stdout.write('started');setTimeout(function(){},10000)") },
			controller.signal,
		);
		setTimeout(() => controller.abort(), 100);
		await expect(operation).rejects.toThrow(/Command aborted[\s\S]*stdout:\nstarted[\s\S]*"aborted":true/);
	});

	it("handles a signal aborted during spawn setup", async () => {
		const root = await createTempDir();
		const controller = new AbortController();
		const operations: BashOperations = {
			async run(_command, _cwd, _options) {
				controller.abort();
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		};
		await expect(
			createBashTool(root, { operations }).execute("bash-abort-setup", { command: "ignored" }, controller.signal),
		).rejects.toThrow("Command aborted");
	});

	it("kills descendants when a command times out", async () => {
		const root = await createTempDir();
		const marker = join(root, "descendant-ran.txt");
		await writeFile(
			join(root, "child.cjs"),
			"setTimeout(function(){require('node:fs').writeFileSync('descendant-ran.txt','bad')},500)",
			"utf8",
		);
		await writeFile(
			join(root, "parent.cjs"),
			"require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore'});setTimeout(function(){},10000)",
			"utf8",
		);
		await expect(
			createBashTool(root).execute("bash-tree", { command: nodeCommand("require('./parent.cjs')"), timeoutMs: 100 }),
		).rejects.toThrow("Command timed out after 100 ms");
		await waitForMissing(marker, 800);
	});

	it("truncates stdout and stderr independently without broken UTF-8", async () => {
		const root = await createTempDir();
		const result = await createBashTool(root, { maxOutputBytes: 5 }).execute("bash-truncate", {
			command: nodeCommand("process.stdout.write('你好');process.stderr.write('世界')"),
		});
		const text = textOf(result);
		expect(text).toContain("stdout:\n你");
		expect(text).toContain("stderr:\n世");
		expect(text).not.toContain("�");
		expect(statusOf(text)).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
	});

	it("rejects an empty command and invalid timeout on direct calls", async () => {
		const root = await createTempDir();
		await expect(createBashTool(root).execute("bash-empty-command", { command: "" })).rejects.toThrow(
			"command must not be empty",
		);
		await expect(
			createBashTool(root).execute("bash-timeout-zero", { command: "echo ok", timeoutMs: 0 }),
		).rejects.toThrow("timeoutMs must be an integer between 1 and 300000");
	});

	it("passes the default timeout to injected operations", async () => {
		const root = await createTempDir();
		let receivedTimeout: number | undefined;
		const operations: BashOperations = {
			async run(_command, _cwd, options) {
				receivedTimeout = options.timeoutMs;
				return { exitCode: 0, timedOut: false, aborted: false };
			},
		};
		await createBashTool(root, { operations }).execute("bash-default-timeout", { command: "ignored" });
		expect(receivedTimeout).toBe(DEFAULT_BASH_TIMEOUT_MS);
	});

	it("propagates a spawn failure", async () => {
		const root = await createTempDir();
		const operations: BashOperations = {
			async run() {
				throw new Error("spawn failed");
			},
		};
		await expect(createBashTool(root, { operations }).execute("bash-spawn", { command: "ignored" })).rejects.toThrow(
			"spawn failed",
		);
	});
});

describe("AgentSession bash integration", () => {
	it("sends a successful bash result to the second provider request", async () => {
		const root = await createTempDir("di-code-bash-session-");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "bash-session-1",
							name: "bash",
							arguments: { command: nodeCommand("process.stdout.write('session-ok')") },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Command completed." }] },
			],
		});
		const requestedMessages: Message[][] = [];
		const provider: Provider = {
			...faux.provider,
			stream(model, context: Context, options) {
				requestedMessages.push([...context.messages]);
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
		await session.prompt("Run the command");
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		const result = findToolResult(session.transcript, "bash-session-1");
		expect(result).toMatchObject({ toolName: "bash", isError: false });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("session-ok") });
	});

	it("returns a non-zero exit to the model and lets it recover", async () => {
		const root = await createTempDir("di-code-bash-session-");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "bash-session-2",
							name: "bash",
							arguments: { command: nodeCommand("process.exit(9)") },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The command failed." }] },
			],
		});
		const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
		const assistant = await session.prompt("Run the failing command");
		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The command failed." }],
		});
		const result = findToolResult(session.transcript, "bash-session-2");
		expect(result.isError).toBe(true);
		const content = result.content[0];
		if (!content || content.type !== "text") throw new Error("Expected bash text error");
		expect(content.text).toContain("Command exited with code 9");
	});
});
