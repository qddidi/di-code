import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext, createServiceKey, EventBus, type PluginDefinition } from "@di-code/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { disposeRpcComposition } from "../src/rpc/lifecycle.ts";

interface ResourceInventory {
	listeners: number;
	timers: number;
	servers: number;
	children: number;
	files: number;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function emptyInventory(): ResourceInventory {
	return { listeners: 0, timers: 0, servers: 0, children: 0, files: 0 };
}

function namespaceModule<T>(definition: PluginDefinition<T>): PluginModule {
	return {
		apiVersion: definition.apiVersion ?? 1,
		name: definition.name,
		...(definition.version === undefined ? {} : { version: definition.version }),
		apply: (context, config, fiber) => definition.apply(context, config as T, fiber),
	};
}

describe("plugin chaos e2e", () => {
	it("rolls back import/setup/handler/dispose failures without retaining healthy contributions", async () => {
		const context = createRootContext({ id: "chaos-failures", mode: "test", trustedProject: true });
		const contributionKey = createServiceKey<string>("healthy-contribution");
		const healthy: PluginDefinition = {
			name: "healthy",
			apply: (current) => current.set(contributionKey, "healthy"),
		};
		const setupFailure: PluginDefinition = {
			name: "setup-failure",
			apply: (current) => {
				current.set(createServiceKey("rolled-back"), true);
				throw new Error("setup injected failure");
			},
		};
		const loader = createCompositionLoader({
			context,
			entries: [
				{ id: "healthy", name: "healthy" },
				{ id: "import", name: "import", required: false },
				{ id: "setup", name: "setup", required: false },
			],
			importModule: async (name) => {
				if (name === "healthy") return namespaceModule(healthy);
				if (name === "setup") return namespaceModule(setupFailure);
				throw new Error("import injected failure");
			},
		});
		const events = new EventBus<string>();
		const handler = events.subscribe(async () => {
			throw new Error("handler injected failure");
		});
		try {
			const inventory = await loader.load();
			expect(inventory.get("healthy")?.status).toBe("active");
			expect(inventory.get("import")?.status).toBe("skipped");
			expect(inventory.get("setup")?.status).toBe("skipped");
			expect(context.require(contributionKey)).toBe("healthy");
			await expect(events.emit("failure")).resolves.toMatchObject({ failures: [expect.any(Error)] });
		} finally {
			handler();
			events.dispose();
			await loader.dispose();
			await context.dispose();
		}

		const requiredContext = createRootContext({ id: "chaos-required", mode: "test", trustedProject: true });
		const requiredLoader = createCompositionLoader({
			context: requiredContext,
			entries: [{ id: "broken", name: "broken" }],
			importModule: async () => namespaceModule(setupFailure),
		});
		try {
			await expect(requiredLoader.load()).rejects.toThrow(/Required entry broken failed/);
		} finally {
			await requiredLoader.dispose();
			await requiredContext.dispose();
		}
	});

	it("releases listener, timer, mock-server, child-process, and file inventories after 100 reloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-plugin-chaos-"));
		roots.push(root);
		const childScript = join(root, "child.mjs");
		await writeFile(childScript, "process.exitCode = 7;\n", "utf8");
		const inventory = emptyInventory();
		const emitter = new EventEmitter();
		const resourcePlugin: PluginDefinition = {
			name: "resource-plugin",
			apply: async (_context, _config, fiber) => {
				const listener = (): void => undefined;
				emitter.on("change", listener);
				inventory.listeners += 1;
				const timer = setInterval(() => undefined, 1_000);
				inventory.timers += 1;
				const file = await open(join(root, `${fiber.id}.txt`), "w");
				inventory.files += 1;
				const server = createServer((_request, response) => response.end("mock"));
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
				inventory.servers += 1;
				const child = spawn(process.execPath, [childScript], { stdio: "ignore" });
				inventory.children += 1;
				await once(child, "exit");
				fiber.addDisposer(async () => {
					emitter.off("change", listener);
					inventory.listeners -= 1;
					clearInterval(timer);
					inventory.timers -= 1;
					await file.close();
					inventory.files -= 1;
					await closeServer(server);
					inventory.servers -= 1;
					inventory.children -= 1;
				});
			},
		};
		const disposeFailure: PluginDefinition = {
			name: "dispose-failure",
			apply: () => () => {
				throw new Error("dispose injected failure");
			},
		};

		for (let index = 0; index < 100; index += 1) {
			const context = createRootContext({ id: `chaos-${index}`, mode: "test", trustedProject: true });
			const loader = createCompositionLoader({
				context,
				entries: [
					{ id: "resource", name: "resource" },
					{ id: "dispose", name: "dispose", required: false },
				],
				importModule: async (name): Promise<PluginModule> =>
					namespaceModule(name === "resource" ? resourcePlugin : disposeFailure),
			});
			try {
				await loader.load();
			} finally {
				await expect(loader.dispose()).rejects.toThrow("dispose injected failure");
				await context.dispose().catch(() => undefined);
			}
			expect(inventory).toEqual(emptyInventory());
			expect(emitter.listenerCount("change")).toBe(0);
		}
	}, 30_000);

	it("releases both owners when RPC flush and composition disposal fail", async () => {
		let loaderDisposed = false;
		let contextDisposed = false;
		await expect(
			disposeRpcComposition(
				() => {
					loaderDisposed = true;
					throw new Error("flush injected failure");
				},
				() => {
					contextDisposed = true;
					throw new Error("dispose injected failure");
				},
			),
		).rejects.toBeInstanceOf(AggregateError);
		expect(loaderDisposed).toBe(true);
		expect(contextDisposed).toBe(true);
	});
});
