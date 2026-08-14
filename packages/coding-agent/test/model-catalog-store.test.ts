import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@di-code/ai";
import { afterEach, describe, expect, it } from "vitest";
import { FileModelCatalogStore } from "../src/core/model-catalog-store.ts";

const model: Model = {
	id: "cached",
	name: "Cached",
	provider: "openai",
	api: "openai-responses",
	input: ["text"],
	reasoning: false,
	contextWindow: 1_000,
	maxOutputTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("FileModelCatalogStore", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("returns undefined for a missing cache and round-trips a versioned entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-model-cache-"));
		roots.push(root);
		const path = join(root, "nested", "openai.json");
		const store = new FileModelCatalogStore(path);

		await expect(store.read()).resolves.toBeUndefined();
		await store.write({ models: [model], checkedAt: 123 });

		await expect(store.read()).resolves.toEqual({ models: [model], checkedAt: 123 });
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, checkedAt: 123 });
	});

	it("reports malformed and unsupported cache files with their path", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-model-cache-"));
		roots.push(root);
		const path = join(root, "cache.json");
		const store = new FileModelCatalogStore(path);

		await writeFile(path, "{");
		await expect(store.read()).rejects.toThrow(`Invalid model catalog cache ${path}`);
		await writeFile(path, JSON.stringify({ version: 2, models: [], checkedAt: 0 }));
		await expect(store.read()).rejects.toThrow(`Unsupported model catalog cache version in ${path}`);
	});
});
