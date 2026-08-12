import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

function textOf(blocks: Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>): string {
	return blocks
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("read tool text windows", () => {
	let root: string;
	let outside: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-read-root-"));
		outside = await mkdtemp(join(tmpdir(), "di-code-read-outside-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});

	it("reads a UTF-8 text file", async () => {
		await writeFile(join(root, "notes.txt"), "第一行\nsecond line", "utf8");
		const blocks = await createReadTool(root).execute("call-1", { path: "notes.txt" });
		expect(textOf(blocks)).toBe("第一行\nsecond line");
	});

	it("reads an empty file as empty text", async () => {
		await writeFile(join(root, "empty.txt"), "", "utf8");
		const blocks = await createReadTool(root).execute("call-2", { path: "empty.txt" });
		expect(textOf(blocks)).toBe("");
	});

	it("applies a 1-based offset", async () => {
		await writeFile(join(root, "offset.txt"), "line 1\nline 2\nline 3", "utf8");
		const blocks = await createReadTool(root).execute("call-3", { path: "offset.txt", offset: 2 });
		expect(textOf(blocks)).toBe("line 2\nline 3");
	});

	it("applies limit and emits the next offset", async () => {
		await writeFile(join(root, "limit.txt"), "line 1\nline 2\nline 3", "utf8");
		const blocks = await createReadTool(root).execute("call-4", { path: "limit.txt", limit: 2 });
		expect(textOf(blocks)).toBe("line 1\nline 2\n\n[1 more lines in file. Use offset=3 to continue.]");
	});

	it("combines offset and limit", async () => {
		await writeFile(join(root, "window.txt"), "line 1\nline 2\nline 3\nline 4", "utf8");
		const blocks = await createReadTool(root).execute("call-5", {
			path: "window.txt",
			offset: 2,
			limit: 2,
		});
		expect(textOf(blocks)).toBe("line 2\nline 3\n\n[1 more lines in file. Use offset=4 to continue.]");
	});

	it("rejects an offset beyond the end of the file", async () => {
		await writeFile(join(root, "short.txt"), "line 1\nline 2", "utf8");
		await expect(createReadTool(root).execute("call-6", { path: "short.txt", offset: 3 })).rejects.toThrow(
			"Offset 3 is beyond end of file (2 lines total)",
		);
	});

	it("defensively rejects a non-positive offset", async () => {
		await writeFile(join(root, "notes.txt"), "text", "utf8");
		await expect(createReadTool(root).execute("call-7", { path: "notes.txt", offset: 0 })).rejects.toThrow(
			"offset must be a positive integer",
		);
	});

	it("defensively rejects a non-positive limit", async () => {
		await writeFile(join(root, "notes.txt"), "text", "utf8");
		await expect(createReadTool(root).execute("call-8", { path: "notes.txt", limit: 0 })).rejects.toThrow(
			"limit must be a positive integer",
		);
	});

	it("preserves ENOENT for a missing file inside the root", async () => {
		await expect(createReadTool(root).execute("call-9", { path: "missing.txt" })).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects absolute and relative paths outside the root before reading", async () => {
		const outsideFile = join(outside, "missing.txt");
		await expect(createReadTool(root).execute("call-10a", { path: outsideFile })).rejects.toThrow(
			"Path is outside the allowed root",
		);
		await expect(createReadTool(root).execute("call-10b", { path: relative(root, outsideFile) })).rejects.toThrow(
			"Path is outside the allowed root",
		);
	});

	it("defensively rejects an empty path", async () => {
		await expect(createReadTool(root).execute("call-11", { path: "" })).rejects.toThrow("path must not be empty");
	});

	it("rejects binary-looking content", async () => {
		await writeFile(join(root, "data.bin"), Buffer.from([0x41, 0x00, 0x42, 0xff]));
		await expect(createReadTool(root).execute("call-12", { path: "data.bin" })).rejects.toThrow(
			"Binary files are not supported by read",
		);
	});

	it("rejects a pre-aborted read", async () => {
		await writeFile(join(root, "notes.txt"), "text", "utf8");
		const controller = new AbortController();
		controller.abort("test");
		await expect(createReadTool(root).execute("call-13", { path: "notes.txt" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
	});

	it("rejects a non-positive maxLines option", () => {
		expect(() => createReadTool(root, { maxLines: 0 })).toThrow("maxLines must be a positive integer");
	});

	it("rejects a non-positive maxBytes option", () => {
		expect(() => createReadTool(root, { maxBytes: 0 })).toThrow("maxBytes must be a positive integer");
	});

	it("truncates by line count and gives the next offset", async () => {
		await writeFile(join(root, "long.txt"), "line 1\nline 2\nline 3\nline 4", "utf8");
		const blocks = await createReadTool(root, { maxLines: 2 }).execute("call-14", { path: "long.txt" });
		const output = textOf(blocks);
		expect(output).toContain("line 1\nline 2");
		expect(output).not.toContain("line 3");
		expect(output).toContain("[Showing lines 1-2 of 4. Use offset=3 to continue.]");
	});

	it("truncates by UTF-8 bytes without returning a partial line", async () => {
		const line = "中".repeat(20);
		await writeFile(join(root, "bytes.txt"), `${line}\n${line}\n${line}`, "utf8");
		const blocks = await createReadTool(root, { maxLines: 100, maxBytes: 125 }).execute("call-15", {
			path: "bytes.txt",
		});
		const output = textOf(blocks);
		expect(output).toContain(`${line}\n${line}`);
		expect(output).not.toContain(`${line}\n${line}\n${line}`);
		expect(output).toContain("[Showing lines 1-2 of 3 (125 bytes limit). Use offset=3 to continue.]");
	});

	it("rejects a first line larger than the byte limit", async () => {
		await writeFile(join(root, "one-line.txt"), "中".repeat(20), "utf8");
		await expect(createReadTool(root, { maxBytes: 10 }).execute("call-16", { path: "one-line.txt" })).rejects.toThrow(
			"A single line exceeds the read byte limit",
		);
	});

	it("rejects a symlink whose real target is outside the root", async () => {
		const outsideFile = join(outside, "secret.txt");
		await writeFile(outsideFile, "secret", "utf8");
		const link = join(root, "link.txt");

		try {
			await symlink(outsideFile, link, "file");
		} catch (cause) {
			if (
				process.platform === "win32" &&
				cause instanceof Error &&
				"code" in cause &&
				(cause.code === "EPERM" || cause.code === "EACCES")
			) {
				return;
			}
			throw cause;
		}

		await expect(createReadTool(root).execute("call-19", { path: "link.txt" })).rejects.toThrow(
			"Path is outside the allowed root",
		);
	});
});
