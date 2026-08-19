import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupStaleClipboardImages,
	clipboardImageDirectory,
	writeImageContentToTempFile,
} from "../src/core/clipboard-image.ts";

describe("clipboard image files", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "di-code-clipboard-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("writes a validated image content block to a temporary file", async () => {
		const path = await writeImageContentToTempFile(
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			directory,
		);

		expect(path).toMatch(/di-code-clipboard-[0-9a-f-]+\.png$/i);
		await expect(readFile(path)).resolves.toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	});

	it("creates a user-data clipboard directory and removes stale generated files", async () => {
		const root = join(directory, "project");
		const agentDir = join(directory, "agent");
		const clipboardDirectory = clipboardImageDirectory(agentDir, root);
		const path = await writeImageContentToTempFile(
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			clipboardDirectory,
		);
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await utimes(path, old, old);

		await cleanupStaleClipboardImages(agentDir, root);

		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(clipboardDirectory.startsWith(agentDir)).toBe(true);
		expect(clipboardDirectory.startsWith(root)).toBe(false);
	});
});
