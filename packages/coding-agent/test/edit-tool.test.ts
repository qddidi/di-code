import { readFile as fsReadFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Provider } from "@di-code/ai";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(prefix = "di-code-edit-root-"): Promise<string> {
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

function findToolResult(messages: readonly Message[], toolCallId: string) {
	const result = messages.find((message) => message.role === "tool_result" && message.toolCallId === toolCallId);
	if (!result || result.role !== "tool_result") throw new Error(`Missing tool result for ${toolCallId}`);
	return result;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createEditTool", () => {
	it("replaces one unique block and preserves CRLF plus BOM", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "\uFEFFfirst\r\n你好\r\nlast", "utf8");
		const result = await createEditTool(root).execute("edit-1", {
			path: "notes.txt",
			oldText: "你好\n",
			newText: "世界\n",
		});
		expect(result).toEqual([{ type: "text", text: "Successfully replaced text in notes.txt" }]);
		expect((await fsReadFile(target)).toString("utf8")).toBe("\uFEFFfirst\r\n世界\r\nlast");
	});

	it("rejects a missing match without writing", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "hello", "utf8");
		await expect(
			createEditTool(root).execute("edit-2", { path: "notes.txt", oldText: "nope", newText: "x" }),
		).rejects.toThrow("Text to replace was not found in notes.txt");
		expect((await fsReadFile(target)).toString()).toBe("hello");
	});

	it("rejects an ambiguous match without writing", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "hello hello", "utf8");
		await expect(
			createEditTool(root).execute("edit-3", { path: "notes.txt", oldText: "hello", newText: "x" }),
		).rejects.toThrow("Text to replace is ambiguous in notes.txt");
		expect((await fsReadFile(target)).toString()).toBe("hello hello");
	});

	it("rejects overlapping matches as ambiguous", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "aaa", "utf8");
		await expect(
			createEditTool(root).execute("edit-overlap", { path: "notes.txt", oldText: "aa", newText: "x" }),
		).rejects.toThrow("Text to replace is ambiguous in notes.txt");
		expect((await fsReadFile(target)).toString()).toBe("aaa");
	});

	it("rejects binary files without writing", async () => {
		const root = await createTempDir();
		const target = join(root, "binary.dat");
		const bytes = Buffer.from([0x61, 0x00, 0x62]);
		await writeFile(target, bytes);
		await expect(
			createEditTool(root).execute("edit-binary", { path: "binary.dat", oldText: "a", newText: "x" }),
		).rejects.toThrow("Binary files are not supported by edit");
		expect(await fsReadFile(target)).toEqual(bytes);
	});

	it("rejects invalid UTF-8 without writing", async () => {
		const root = await createTempDir();
		const target = join(root, "invalid.txt");
		const bytes = Buffer.from([0x61, 0xff, 0x62]);
		await writeFile(target, bytes);
		await expect(
			createEditTool(root).execute("edit-invalid-utf8", { path: "invalid.txt", oldText: "a", newText: "x" }),
		).rejects.toThrow("File is not valid UTF-8: invalid.txt");
		expect(await fsReadFile(target)).toEqual(bytes);
	});

	it("rejects empty oldText when called directly", async () => {
		const root = await createTempDir();
		await expect(
			createEditTool(root).execute("edit-4", { path: "notes.txt", oldText: "", newText: "x" }),
		).rejects.toThrow("oldText must not be empty");
	});

	it("rejects a path outside the allowed root", async () => {
		const root = await createTempDir();
		const outside = await createTempDir("di-code-edit-outside-");
		await expect(
			createEditTool(root).execute("edit-5", { path: join(outside, "notes.txt"), oldText: "a", newText: "b" }),
		).rejects.toThrow("Path is outside the allowed root");
	});

	it("rejects an external change between reads", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "before", "utf8");
		let reads = 0;
		let writes = 0;
		const tool = createEditTool(root, {
			operations: {
				readFile: async (filePath) => {
					reads += 1;
					const bytes = await fsReadFile(filePath);
					if (reads === 1) await writeFile(filePath, "external", "utf8");
					return bytes;
				},
				writeFile: async () => {
					writes += 1;
				},
			},
		});
		await expect(tool.execute("edit-6", { path: "notes.txt", oldText: "before", newText: "after" })).rejects.toThrow(
			"File changed during edit: notes.txt",
		);
		expect(writes).toBe(0);
	});

	it("serializes concurrent edits and preserves both changes", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "alpha\nbeta", "utf8");
		const gate = createDeferred();
		const tool = createEditTool(root, {
			operations: {
				readFile: async (filePath) => fsReadFile(filePath),
				writeFile: async (filePath, content) => {
					if (content.includes("ALPHA")) await gate.promise;
					await writeFile(filePath, content, "utf8");
				},
			},
		});
		const first = tool.execute("edit-7a", { path: "notes.txt", oldText: "alpha", newText: "ALPHA" });
		const second = tool.execute("edit-7b", { path: "notes.txt", oldText: "beta", newText: "BETA" });
		await Promise.resolve();
		gate.resolve();
		await Promise.all([first, second]);
		expect((await fsReadFile(target)).toString()).toBe("ALPHA\nBETA");
	});

	it("shares the queue with write", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "old", "utf8");
		const editStarted = createDeferred();
		const finishEdit = createDeferred();
		const edit = createEditTool(root, {
			operations: {
				readFile: async (filePath) => fsReadFile(filePath),
				writeFile: async (filePath, content) => {
					editStarted.resolve();
					await finishEdit.promise;
					await writeFile(filePath, content, "utf8");
				},
			},
		});
		const write = createWriteTool(root);
		const first = edit.execute("edit-8", { path: "notes.txt", oldText: "old", newText: "edited" });
		await editStarted.promise;
		const second = write.execute("write-8", { path: "notes.txt", content: "written" });
		await Promise.resolve();
		finishEdit.resolve();
		await Promise.all([first, second]);
		expect((await fsReadFile(target)).toString()).toBe("written");
	});

	it("does not read when already aborted", async () => {
		const root = await createTempDir();
		const controller = new AbortController();
		controller.abort();
		await expect(
			createEditTool(root).execute("edit-9", { path: "notes.txt", oldText: "a", newText: "b" }, controller.signal),
		).rejects.toThrow("Operation aborted");
	});

	it("keeps the queue locked until an aborted in-flight edit settles", async () => {
		const root = await createTempDir();
		const target = join(root, "notes.txt");
		await writeFile(target, "alpha\nbeta", "utf8");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		let readCount = 0;
		let firstWriteSettled = false;
		const tool = createEditTool(root, {
			operations: {
				readFile: async (filePath) => {
					readCount += 1;
					return fsReadFile(filePath);
				},
				writeFile: async (filePath, content) => {
					if (content.includes("ALPHA")) {
						firstWriteStarted.resolve();
						await finishFirstWrite.promise;
						await writeFile(filePath, content, "utf8");
						firstWriteSettled = true;
						return;
					}
					expect(firstWriteSettled).toBe(true);
					await writeFile(filePath, content, "utf8");
				},
			},
		});
		const controller = new AbortController();
		const first = tool.execute(
			"edit-abort-first",
			{ path: "notes.txt", oldText: "alpha", newText: "ALPHA" },
			controller.signal,
		);
		await firstWriteStarted.promise;
		controller.abort();
		const second = tool.execute("edit-abort-second", {
			path: "notes.txt",
			oldText: "beta",
			newText: "BETA",
		});
		await Promise.resolve();
		expect(readCount).toBe(2);
		finishFirstWrite.resolve();
		await expect(first).rejects.toThrow("Operation aborted");
		await second;
		expect((await fsReadFile(target)).toString()).toBe("ALPHA\nBETA");
	});
});

describe("AgentSession edit integration", () => {
	it("returns successful edit result to the model", async () => {
		const root = await createTempDir("di-code-edit-session-");
		await writeFile(join(root, "notes.txt"), "before", "utf8");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "edit-session-1",
							name: "edit",
							arguments: { path: "notes.txt", oldText: "before", newText: "after" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Edited." }] },
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
		await session.prompt("Edit notes");
		expect((await fsReadFile(join(root, "notes.txt"))).toString()).toBe("after");
		expect(requestedMessages[1]?.map((message) => message.role)).toEqual(["user", "assistant", "tool_result"]);
		expect(findToolResult(session.transcript, "edit-session-1")).toMatchObject({ toolName: "edit", isError: false });
	});

	it("returns an edit failure and lets the model recover", async () => {
		const root = await createTempDir("di-code-edit-session-");
		await writeFile(join(root, "notes.txt"), "before", "utf8");
		const faux = createFauxProvider({
			responses: [
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "edit-session-2",
							name: "edit",
							arguments: { path: "notes.txt", oldText: "missing", newText: "after" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Rejected." }] },
			],
		});
		const session = new AgentSession({ allowedRoot: root, provider: faux.provider, model: faux.model });
		const assistant = await session.prompt("Edit notes");
		expect(assistant).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Rejected." }] });
		const result = findToolResult(session.transcript, "edit-session-2");
		expect(result.isError).toBe(true);
	});
});
