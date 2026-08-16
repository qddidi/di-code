import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
	readonly name: string;
	readonly version: string;
	readonly private?: boolean;
	readonly license?: string;
	readonly files?: readonly string[];
	readonly scripts?: Record<string, string>;
	readonly dependencies?: Record<string, string>;
	readonly exports?: Record<string, unknown>;
	readonly bin?: Record<string, string>;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceDirectories = ["ai", "agent", "tui", "coding-agent", "orchestrator"] as const;

async function readPackage(path: string): Promise<PackageMetadata> {
	return JSON.parse(await readFile(path, "utf8")) as PackageMetadata;
}

describe("release package contract", () => {
	it("keeps the root private and publishes all workspaces at one version", async () => {
		const root = await readPackage(join(repositoryRoot, "package.json"));
		expect(root.private).toBe(true);
		expect(root.version).toMatch(/^\d+\.\d+\.\d+$/);

		for (const directory of workspaceDirectories) {
			const metadata = await readPackage(join(repositoryRoot, "packages", directory, "package.json"));
			expect(metadata).toMatchObject({ version: root.version, private: false, license: "MIT", files: ["dist"] });
			const readme = await readFile(join(repositoryRoot, "packages", directory, "README.md"), "utf8");
			expect(readme).toContain("https://github.com/qddidi/di-code");
			for (const [name, version] of Object.entries(metadata.dependencies ?? {})) {
				if (name.startsWith("@di-code/")) expect(version).toBe(root.version);
			}
		}
	});

	it("exposes both CLI entry points and the public RPC SDK", async () => {
		const codingAgent = await readPackage(join(repositoryRoot, "packages", "coding-agent", "package.json"));
		expect(codingAgent.bin).toEqual({
			"di-code": "./dist/entry.js",
			"di-code-rpc": "./dist/rpc-entry.js",
		});
		expect(codingAgent.exports).toHaveProperty("./rpc");
	});

	it("defines reproducible root build and release dry-run commands", async () => {
		const root = await readPackage(join(repositoryRoot, "package.json"));
		expect(root.scripts?.build).toContain("@di-code/orchestrator");
		expect(root.scripts?.["release:dry-run"]).toBe("node scripts/release-dry-run.mjs");
	});
});
