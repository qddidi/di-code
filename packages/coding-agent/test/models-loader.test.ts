import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelsDocument } from "../src/config/models-loader.ts";

describe("loadModelsDocument", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("loads custom providers without resolving their keys", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-models-"));
		roots.push(root);
		const path = join(root, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: "http://localhost:11434/v1",
						api: "openai-responses",
						apiKeyEnv: "OLLAMA_API_KEY",
						models: [{ id: "qwen2.5-coder:7b" }],
					},
				},
			}),
		);

		await expect(loadModelsDocument(path)).resolves.toMatchObject({
			providers: { ollama: { api: "openai-responses", apiKeyEnv: "OLLAMA_API_KEY" } },
		});
	});

	it("supports partial overlays for built-in providers", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-models-"));
		roots.push(root);
		const path = join(root, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: { anthropic: { modelOverrides: { "claude-sonnet-4-5": { name: "Proxy Claude" } } } },
			}),
		);

		await expect(loadModelsDocument(path)).resolves.toMatchObject({
			providers: { anthropic: { modelOverrides: { "claude-sonnet-4-5": { name: "Proxy Claude" } } } },
		});
	});

	it("rejects raw secrets, unsupported APIs, and unsafe URLs", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-models-"));
		roots.push(root);
		const path = join(root, "models.json");
		await mkdir(root, { recursive: true });

		await writeFile(
			path,
			JSON.stringify({
				providers: { provider: { baseUrl: "http://localhost", api: "openai-responses", apiKey: "secret" } },
			}),
		);
		await expect(loadModelsDocument(path)).rejects.toThrow("apiKey");

		await writeFile(
			path,
			JSON.stringify({ providers: { provider: { baseUrl: "file:///secret", api: "openai-responses" } } }),
		);
		await expect(loadModelsDocument(path)).rejects.toThrow("http or https");

		await writeFile(
			path,
			JSON.stringify({ providers: { provider: { baseUrl: "http://localhost", api: "google-generative-ai" } } }),
		);
		await expect(loadModelsDocument(path)).rejects.toThrow("unsupported API");
	});
});
