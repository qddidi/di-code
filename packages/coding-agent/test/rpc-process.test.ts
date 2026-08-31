import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginInstallManager } from "@di-code/plugin-loader";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/rpc/client.ts";

const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
	await Promise.all(
		[...children].map(async (child) => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
		}),
	);
	children.clear();
});

describe("di-code-rpc process", () => {
	it("serves a versioned faux-provider conversation over stdin/stdout", async () => {
		const entryPath = fileURLToPath(new URL("../src/rpc-entry.ts", import.meta.url));
		const child = spawn(process.execPath, ["--experimental-strip-types", entryPath], {
			cwd: process.cwd(),
			env: { ...process.env, DI_CODE_PROVIDER: "faux" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.add(child);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const client = new RpcClient({
			readable: child.stdout,
			writable: child.stdin,
			onExit(listener) {
				child.on("exit", listener);
				return () => child.off("exit", listener);
			},
		});

		await expect(client.getState()).resolves.toMatchObject({
			modelId: "faux-model",
			isStreaming: false,
			messageCount: 0,
		});
		await expect(client.prompt("hello")).resolves.toMatchObject({
			stopReason: "stop",
			provider: "faux",
		});
		expect(stderr).toBe("");

		client.close();
		child.stdin.end();
		await once(child, "exit");
	});

	it("does not import managed or project entries before project trust", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-rpc-profile-"));
		const home = join(root, "home");
		const source = join(root, "managed-source");
		const managedMarker = join(root, "managed-loaded");
		const projectMarker = join(root, "project-loaded");
		const projectEntry = join(root, "project-entry.mjs");
		const entryPath = fileURLToPath(new URL("../src/rpc-entry.ts", import.meta.url));
		try {
			await mkdir(join(root, ".di-code"), { recursive: true });
			await mkdir(source, { recursive: true });
			await writeFile(
				join(source, "package.json"),
				JSON.stringify({
					name: "rpc-managed-plugin",
					version: "1.0.0",
					type: "module",
					exports: { "./plugin": "./index.mjs" },
					diCode: {
						apiVersion: 1,
						plugins: ["./plugin"],
						permissions: { filesystem: "none", network: [], process: [] },
						capabilities: {},
					},
				}),
			);
			await writeFile(
				join(source, "index.mjs"),
				"import { writeFileSync } from 'node:fs'; export const apiVersion = 1; export const name = 'rpc-managed-plugin'; export const apply = () => writeFileSync(process.env.DI_CODE_TEST_RPC_MANAGED_MARKER, 'loaded');",
			);
			await writeFile(
				projectEntry,
				"import { writeFileSync } from 'node:fs'; export const apiVersion = 1; export const name = 'rpc-project-plugin'; export const apply = () => writeFileSync(process.env.DI_CODE_TEST_RPC_PROJECT_MARKER, 'loaded');",
			);
			await writeFile(
				join(root, ".di-code", "composition.yml"),
				`entries:\n  - id: project-marker\n    name: ${JSON.stringify(new URL(`file:///${projectEntry.replaceAll("\\", "/")}`).href)}\n`,
			);
			const manager = new PluginInstallManager({ managedRoot: join(home, ".di-code", "plugins", "installed") });
			await manager.installLocal(source);

			const child = spawn(process.execPath, ["--experimental-strip-types", entryPath], {
				cwd: root,
				env: {
					...process.env,
					DI_CODE_PROVIDER: "faux",
					DI_CODE_TEST_RPC_MANAGED_MARKER: managedMarker,
					DI_CODE_TEST_RPC_PROJECT_MARKER: projectMarker,
					HOME: home,
					USERPROFILE: home,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			children.add(child);
			const client = new RpcClient({
				readable: child.stdout,
				writable: child.stdin,
				onExit(listener) {
					child.on("exit", listener);
					return () => child.off("exit", listener);
				},
			});

			await expect(client.getState()).resolves.toMatchObject({ modelId: "faux-model" });
			await expect(readFile(managedMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

			client.close();
			child.stdin.end();
			await once(child, "exit");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
