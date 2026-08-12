import { writeFile as fsWriteFile, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Provider } from "@di-code/ai";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { resolveAllowedMutationPath } from "../src/core/tools/path-boundary.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function expectOutsidePath(promise: Promise<unknown>): Promise<void> {
	await expect(promise).rejects.toThrow("Path is outside the allowed root");
}

function findToolResult(messages: readonly Message[], toolCallId: string) {
	const result = messages.find((message) => message.role === "tool_result" && message.toolCallId === toolCallId);
	if (!result || result.role !== "tool_result") throw new Error(`Missing tool result for ${toolCallId}`);
	return result;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveAllowedMutationPath", () => {
	it("resolves a missing nested target inside the allowed root", async () => {
		const root = await createTempDir("di-code-write-root-");
		const resolved = await resolveAllowedMutationPath("nested/file.txt", root);
		expect(resolved).toBe(join(await realpath(root), "nested", "file.txt"));
	});

	it("canonicalizes an in-root symlink ancestor", async () => {
		const root = await createTempDir("di-code-write-root-");
		const targetDirectory = join(root, "target");
		await mkdir(targetDirectory);
		await symlink(targetDirectory, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		const resolved = await resolveAllowedMutationPath("alias/file.txt", root);
		expect(resolved).toBe(join(await realpath(targetDirectory), "file.txt"));
	});

	it("rejects parent traversal outside the allowed root", async () => {
		const root = await createTempDir("di-code-write-root-");
		await expectOutsidePath(resolveAllowedMutationPath("../outside.txt", root));
	});

	it("rejects an absolute path outside the allowed root", async () => {
		const root = await createTempDir("di-code-write-root-");
		const outside = await createTempDir("di-code-write-outside-");
		await expectOutsidePath(resolveAllowedMutationPath(join(outside, "file.txt"), root));
	});

	it("rejects a symlink ancestor that points outside the allowed root", async () => {
		const root = await createTempDir("di-code-write-root-");
		const outside = await createTempDir("di-code-write-outside-");
		await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		await expectOutsidePath(resolveAllowedMutationPath("escape/file.txt", root));
	});

	it("rejects a dangling symlink ancestor", async () => {
		const root = await createTempDir("di-code-write-root-");
		const outside = await createTempDir("di-code-write-outside-");
		const alias = join(root, "dangling");
		await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
		await rm(outside, { recursive: true, force: true });
		await expectOutsidePath(resolveAllowedMutationPath("dangling/file.txt", root));
	});
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same target", async () => {
		const root = await createTempDir("di-code-write-root-");
		const target = join(root, "same.txt");
		const firstStarted = createDeferred();
		const finishFirst = createDeferred();
		const order: string[] = [];

		const first = withFileMutationQueue(target, async () => {
			order.push("first:start");
			firstStarted.resolve();
			await finishFirst.promise;
			order.push("first:end");
		});
		await firstStarted.promise;
		const second = withFileMutationQueue(target, async () => {
			order.push("second:start");
			order.push("second:end");
		});
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		finishFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different targets to execute in parallel", async () => {
		const root = await createTempDir("di-code-write-root-");
		const finish = createDeferred();
		const firstStarted = createDeferred();
		const secondStarted = createDeferred();
		const first = withFileMutationQueue(join(root, "first.txt"), async () => {
			firstStarted.resolve();
			await finish.promise;
		});
		const second = withFileMutationQueue(join(root, "second.txt"), async () => {
			secondStarted.resolve();
			await finish.promise;
		});
		await Promise.all([firstStarted.promise, secondStarted.promise]);
		finish.resolve();
		await Promise.all([first, second]);
	});

	it.runIf(process.platform === "win32")("treats Windows path casing as the same target", async () => {
		const root = await createTempDir("di-code-write-root-");
		const firstStarted = createDeferred();
		const finishFirst = createDeferred();
		const order: string[] = [];
		const first = withFileMutationQueue(join(root, "same.txt"), async () => {
			order.push("first:start");
			firstStarted.resolve();
			await finishFirst.promise;
			order.push("first:end");
		});
		await firstStarted.promise;
		const second = withFileMutationQueue(join(root, "SAME.TXT"), async () => {
			order.push("second:start");
			order.push("second:end");
		});
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		finishFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});
});

describe("createWriteTool", () => {
	it("creates parent directories and reports UTF-8 bytes", async () => {
		const root = await createTempDir("di-code-write-root-");
		const result = await createWriteTool(root).execute("write-1", {
			path: "nested/greeting.txt",
			content: "你好\n",
		});
		expect(await readFile(join(root, "nested/greeting.txt"), "utf8")).toBe("你好\n");
		expect(result).toEqual([{ type: "text", text: "Successfully wrote 7 bytes to nested/greeting.txt" }]);
	});

	it("overwrites an existing file", async () => {
		const root = await createTempDir("di-code-write-root-");
		const target = join(root, "notes.txt");
		await fsWriteFile(target, "old", "utf8");
		await createWriteTool(root).execute("write-2", { path: "notes.txt", content: "new content" });
		expect(await readFile(target, "utf8")).toBe("new content");
	});

	it("rejects an empty path when called directly", async () => {
		const root = await createTempDir("di-code-write-root-");
		await expect(createWriteTool(root).execute("write-empty", { path: "", content: "data" })).rejects.toThrow(
			"path must not be empty",
		);
	});

	it("does not create a file when already aborted", async () => {
		const root = await createTempDir("di-code-write-root-");
		const controller = new AbortController();
		controller.abort();
		await expect(
			createWriteTool(root).execute("write-aborted", { path: "never.txt", content: "data" }, controller.signal),
		).rejects.toThrow("Operation aborted");
		await expect(readFile(join(root, "never.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serializes two writes to the same file", async () => {
		const root = await createTempDir("di-code-write-root-");
		const firstStarted = createDeferred();
		const finishFirst = createDeferred();
		const order: string[] = [];
		const tool = createWriteTool(root, {
			operations: {
				mkdir: async (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
				writeFile: async (filePath, content) => {
					order.push(`${content}:start`);
					if (content === "first") {
						firstStarted.resolve();
						await finishFirst.promise;
					}
					await fsWriteFile(filePath, content, "utf8");
					order.push(`${content}:end`);
				},
			},
		});
		const first = tool.execute("write-first", { path: "same.txt", content: "first" });
		await firstStarted.promise;
		const second = tool.execute("write-second", { path: "same.txt", content: "second" });
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		finishFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
		expect(await readFile(join(root, "same.txt"), "utf8")).toBe("second");
	});

	it("keeps the queue locked until an aborted in-flight write settles", async () => {
		const root = await createTempDir("di-code-write-root-");
		const firstStarted = createDeferred();
		const finishFirst = createDeferred();
		const secondStarted = createDeferred();
		let firstSettled = false;
		let secondHasStarted = false;
		const tool = createWriteTool(root, {
			operations: {
				mkdir: async (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
				writeFile: async (filePath, content) => {
					if (content === "first") {
						firstStarted.resolve();
						await finishFirst.promise;
						await fsWriteFile(filePath, content, "utf8");
						firstSettled = true;
						return;
					}
					expect(firstSettled).toBe(true);
					secondHasStarted = true;
					secondStarted.resolve();
					await fsWriteFile(filePath, content, "utf8");
				},
			},
		});
		const controller = new AbortController();
		const first = tool.execute("write-first", { path: "same.txt", content: "first" }, controller.signal);
		await firstStarted.promise;
		controller.abort();
		const second = tool.execute("write-second", { path: "same.txt", content: "second" });
		await Promise.resolve();
		expect(secondHasStarted).toBe(false);
		finishFirst.resolve();
		await expect(first).rejects.toThrow("Operation aborted");
		await second;
		expect(await readFile(join(root, "same.txt"), "utf8")).toBe("second");
	});
});

describe("AgentSession write integration", () => {
	it("writes a file and sends the result to the second provider request", async () => {
		const root = await createTempDir("di-code-write-session-");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "write-session-1",
							name: "write",
							arguments: { path: "notes/result.txt", content: "saved" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The file was saved." }] },
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
		const assistant = await session.prompt("Write the result file");
		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The file was saved." }],
		});
		expect(await readFile(join(root, "notes", "result.txt"), "utf8")).toBe("saved");
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		expect(findToolResult(session.transcript, "write-session-1")).toMatchObject({
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "Successfully wrote 5 bytes to notes/result.txt" }],
		});
	});

	it("returns a path failure to the model and lets the next response recover", async () => {
		const root = await createTempDir("di-code-write-session-");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "write-outside",
							name: "write",
							arguments: { path: "../outside.txt", content: "blocked" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "The unsafe write was rejected." }] },
			],
		});
		const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
		const assistant = await session.prompt("Write outside the root");
		expect(assistant).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "The unsafe write was rejected." }],
		});
		const result = findToolResult(session.transcript, "write-outside");
		expect(result.isError).toBe(true);
		const content = result.content[0];
		if (!content || content.type !== "text") throw new Error("Expected a text tool error");
		expect(content.text).toContain('Tool "write" failed: Path is outside the allowed root');
	});
});
