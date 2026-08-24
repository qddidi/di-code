import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManagedAttachmentStore } from "../src/runtime/attachment-store.ts";

describe("managed WebUI attachment storage", () => {
	it("keeps bytes in an actor-owned directory and deletes them once consumed", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-attachments-"));
		const directory = join(root, "actor-1");
		try {
			const store = await createManagedAttachmentStore({ directory });
			await store.create({
				id: "attachment-1",
				name: "diagram.png",
				contentType: "image/png",
				data: "aGVsbG8=",
				bytes: 5,
			});
			expect(await readdir(directory)).toEqual(["attachment-1.attachment"]);
			await expect(store.take(["attachment-1"])).resolves.toEqual([
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			]);
			expect(await readdir(directory)).toEqual([]);
			await store.dispose();
			await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
