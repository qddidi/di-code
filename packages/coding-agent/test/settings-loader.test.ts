import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings-loader.ts";

describe("loadSettings", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("merges global settings and lets project settings override them", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-settings-"));
		roots.push(root);
		const appData = join(root, "app-data");
		await mkdir(join(appData, "di-code"), { recursive: true });
		await mkdir(join(root, ".di-code"), { recursive: true });
		await writeFile(
			join(appData, "di-code", "settings.json"),
			JSON.stringify({ provider: "faux", model: "global", providers: { anthropic: { apiKeyEnv: "GLOBAL_KEY" } } }),
		);
		await writeFile(
			join(root, ".di-code", "settings.json"),
			JSON.stringify({ provider: "anthropic", providers: { anthropic: { apiKeyEnv: "PROJECT_KEY" } } }),
		);

		await expect(loadSettings({ cwd: root, appData, env: {} })).resolves.toMatchObject({
			settings: { provider: "anthropic", model: "global", providers: { anthropic: { apiKeyEnv: "PROJECT_KEY" } } },
		});
	});

	it("accepts OpenAI provider settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-settings-"));
		roots.push(root);
		await mkdir(join(root, ".di-code"), { recursive: true });
		await writeFile(
			join(root, ".di-code", "settings.json"),
			JSON.stringify({ provider: "openai", providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } } }),
		);

		await expect(loadSettings({ cwd: root, appData: join(root, "missing"), env: {} })).resolves.toMatchObject({
			settings: { provider: "openai", providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } } },
		});
	});

	it("rejects malformed JSON, raw keys, and unsafe base URLs", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-settings-"));
		roots.push(root);
		await mkdir(join(root, ".di-code"), { recursive: true });
		const path = join(root, ".di-code", "settings.json");
		await writeFile(path, "{");
		await expect(loadSettings({ cwd: root, appData: join(root, "missing"), env: {} })).rejects.toThrow(
			`Invalid settings file ${path}: malformed JSON.`,
		);
		await writeFile(path, JSON.stringify({ providers: { anthropic: { apiKey: "secret" } } }));
		await expect(loadSettings({ cwd: root, appData: join(root, "missing"), env: {} })).rejects.toThrow(
			"raw apiKey is not allowed",
		);
		await writeFile(path, JSON.stringify({ providers: { anthropic: { baseUrl: "file:///tmp/key" } } }));
		await expect(loadSettings({ cwd: root, appData: join(root, "missing"), env: {} })).rejects.toThrow(
			"credential-free http(s) URL",
		);
	});
});
