import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session.ts";
import { createGlobTool } from "../src/core/tools/glob.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "di-code-search-root-"));
	tempDirs.push(root);
	return root;
}

function textOf(blocks: readonly { type: string; text?: string }[]): string {
	return blocks
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("glob tool", () => {
	it("finds sorted files relative to the workspace root", async () => {
		const root = await createTempDir();
		await mkdir(join(root, "src", "nested"), { recursive: true });
		await writeFile(join(root, "src", "z.ts"), "", "utf8");
		await writeFile(join(root, "src", "nested", "a.ts"), "", "utf8");
		await writeFile(join(root, "src", "note.md"), "", "utf8");

		const result = textOf(await createGlobTool(root).execute("glob-1", { pattern: "**/*.ts" }));
		expect(result).toBe("src/nested/a.ts\nsrc/z.ts");
	});

	it("matches relative to a requested directory and skips symlinks", async () => {
		const root = await createTempDir();
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "app.ts"), "", "utf8");
		try {
			await symlink(join(root, "src", "app.ts"), join(root, "src", "link.ts"), "file");
		} catch (cause) {
			if (
				process.platform === "win32" &&
				cause instanceof Error &&
				"code" in cause &&
				(cause.code === "EPERM" || cause.code === "EACCES")
			)
				return;
			throw cause;
		}

		const result = textOf(await createGlobTool(root).execute("glob-2", { path: "src", pattern: "*.ts" }));
		expect(result).toBe("src/app.ts");
	});

	it("bounds results", async () => {
		const root = await createTempDir();
		await Promise.all(["a.ts", "b.ts", "c.ts"].map((name) => writeFile(join(root, name), "", "utf8")));
		const result = textOf(await createGlobTool(root).execute("glob-3", { pattern: "*.ts", maxResults: 2 }));
		expect(result).toContain("[Results truncated at 2 matches or 50 KiB.]");
		expect(result.split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(2);
	});

	it("rejects a search path outside the workspace", async () => {
		const root = await createTempDir();
		await expect(createGlobTool(root).execute("glob-4", { path: "..", pattern: "*" })).rejects.toThrow(
			"Path is outside the allowed root",
		);
	});
});

describe("grep tool", () => {
	it("returns literal matches with paths and line numbers", async () => {
		const root = await createTempDir();
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "app.ts"), "const value = 1;\nconst other = value;\n", "utf8");
		await writeFile(join(root, "README.md"), "value in docs\n", "utf8");

		const result = textOf(await createGrepTool(root).execute("grep-1", { pattern: "value", include: "**/*.ts" }));
		expect(result).toBe("src/app.ts:1: const value = 1;\nsrc/app.ts:2: const other = value;");
	});

	it("supports a single file and case-insensitive matching", async () => {
		const root = await createTempDir();
		await writeFile(join(root, "notes.txt"), "Alpha\nbeta\n", "utf8");
		const result = textOf(
			await createGrepTool(root).execute("grep-2", { path: "notes.txt", pattern: "ALPHA", caseSensitive: false }),
		);
		expect(result).toBe("notes.txt:1: Alpha");
	});

	it("skips binary files and reports no matches", async () => {
		const root = await createTempDir();
		await writeFile(join(root, "data.bin"), Buffer.from([0x00, 0x41]));
		await writeFile(join(root, "notes.txt"), "plain text\n", "utf8");
		const result = textOf(await createGrepTool(root).execute("grep-3", { pattern: "missing" }));
		expect(result).toBe("No matches found.");
	});

	it("rejects an empty pattern and pre-aborted calls", async () => {
		const root = await createTempDir();
		await expect(createGrepTool(root).execute("grep-4", { pattern: "" })).rejects.toThrow("pattern must not be empty");
		const controller = new AbortController();
		controller.abort();
		await expect(createGrepTool(root).execute("grep-5", { pattern: "text" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
	});
});

describe("AgentSession search tool registration", () => {
	it("exposes glob and grep to the model", async () => {
		const root = await createTempDir();
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "done" }] }] });
		let toolNames: readonly string[] = [];
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				context: Parameters<typeof faux.provider.stream>[1],
				options: Parameters<typeof faux.provider.stream>[2],
			) {
				toolNames = context.tools?.map((tool) => tool.name) ?? [];
				return faux.provider.stream(model, context, options);
			},
		};
		const session = new AgentSession({ allowedRoot: root, provider, model: faux.model });
		await session.prompt("inspect files");
		expect(toolNames).toEqual(expect.arrayContaining(["glob", "grep"]));
	});
});
