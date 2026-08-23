import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxProvider, type Provider } from "@di-code/ai";
import {
	agentLoop,
	agentLoopKey,
	networkCapability,
	processCapability,
	providerFaux,
	providerRegistry,
	providerRegistryKey,
	runtimeSelection,
	sessionMemory,
	toolApproval,
	toolOutput,
	toolPolicy,
	toolRead,
	toolRegistry,
	toolRegistryKey,
	workspace,
} from "@di-code/builtins";
import { type CompositionEntry, createCompositionLoader, type PluginModule } from "@di-code/plugin-loader";
import { createRootContext, createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";
import { type Terminal, Text, TUI } from "@di-code/tui";
import { describe, expect, it } from "vitest";

function namespaceModule<T>(definition: PluginDefinition<T>): PluginModule {
	return {
		apiVersion: definition.apiVersion ?? 1,
		name: definition.name,
		...(definition.version === undefined ? {} : { version: definition.version }),
		apply: (context, config, fiber) => definition.apply(context, config as T, fiber),
	};
}

const modules = new Map<string, PluginModule>([
	["provider-registry", namespaceModule(providerRegistry)],
	["provider-faux", namespaceModule(providerFaux)],
	["runtime-selection", namespaceModule(runtimeSelection)],
	["session-memory", namespaceModule(sessionMemory)],
	["tool-registry", namespaceModule(toolRegistry)],
	["workspace", namespaceModule(workspace)],
	["process", namespaceModule(processCapability)],
	["network", namespaceModule(networkCapability)],
	["tool-approval", namespaceModule(toolApproval)],
	["tool-policy", namespaceModule(toolPolicy)],
	["tool-output", namespaceModule(toolOutput)],
	["tool-read", namespaceModule(toolRead)],
	["agent-loop", namespaceModule(agentLoop)],
]);

function entry(id: string, options: Omit<CompositionEntry, "id" | "name"> = {}): CompositionEntry {
	return { id, name: id, ...options };
}

function withFauxEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const previousProvider = process.env.DI_CODE_PROVIDER;
	const previousModel = process.env.DI_CODE_MODEL;
	process.env.DI_CODE_PROVIDER = "faux";
	process.env.DI_CODE_MODEL = "faux-model";
	return run().finally(() => {
		if (previousProvider === undefined) delete process.env.DI_CODE_PROVIDER;
		else process.env.DI_CODE_PROVIDER = previousProvider;
		if (previousModel === undefined) delete process.env.DI_CODE_MODEL;
		else process.env.DI_CODE_MODEL = previousModel;
	});
}

function minimalEntries(fauxConfig: CompositionEntry["config"], includeRead = false): readonly CompositionEntry[] {
	return [
		entry("provider-registry"),
		entry("provider-faux", { dependsOn: ["provider-registry"], config: fauxConfig }),
		entry("runtime-selection", { dependsOn: ["provider-registry"] }),
		entry("session-memory"),
		entry("tool-registry"),
		entry("workspace", { dependsOn: ["tool-registry"] }),
		entry("process", { dependsOn: ["tool-registry"] }),
		entry("network", { dependsOn: ["tool-registry"] }),
		entry("tool-approval", { dependsOn: ["tool-registry"] }),
		entry("tool-policy", { dependsOn: ["tool-registry"] }),
		entry("tool-output", { dependsOn: ["tool-registry"] }),
		...(includeRead ? [entry("tool-read", { dependsOn: ["tool-registry", "workspace"] })] : []),
		entry("agent-loop", {
			dependsOn: [
				"runtime-selection",
				"provider-faux",
				"session-memory",
				"tool-registry",
				"workspace",
				"process",
				"network",
				"tool-approval",
				"tool-policy",
				"tool-output",
			],
		}),
	];
}

class VirtualTerminal implements Terminal {
	private started = false;
	private readonly writes: string[] = [];

	start(_onInput: (data: string) => void, _onResize: () => void): void {
		if (this.started) throw new Error("Virtual terminal is already started");
		this.started = true;
	}

	stop(): void {
		this.started = false;
	}

	write(value: string): void {
		this.writes.push(value);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	moveBy(lines: number): void {
		this.write(`move:${lines}`);
	}

	hideCursor(): void {
		this.write("hide");
	}

	showCursor(): void {
		this.write("show");
	}

	clearLine(): void {
		this.write("clear-line");
	}

	clearFromCursor(): void {
		this.write("clear-from-cursor");
	}

	clearScreen(): void {
		this.write("clear-screen");
	}

	setTitle(title: string): void {
		this.write(title);
	}

	get output(): string {
		return this.writes.join("");
	}
}

describe("plugin composability e2e", () => {
	it("keeps the read namespace module isolated from write, edit, bash, and the aggregate entry", async () => {
		const builtinsRoot = resolve(process.cwd(), "..", "builtins", "src");
		const [readEntry, registryEntry] = await Promise.all([
			readFile(join(builtinsRoot, "tool-read.ts"), "utf8"),
			readFile(join(builtinsRoot, "tool-registry.ts"), "utf8"),
		]);
		expect(readEntry).not.toContain("./index.ts");
		expect(readEntry).not.toContain("tool-write");
		expect(readEntry).not.toContain("tool-edit");
		expect(readEntry).not.toContain("tool-bash");
		expect(registryEntry).not.toContain("./index.ts");
		expect(registryEntry).not.toContain("tool-write");
		expect(registryEntry).not.toContain("tool-edit");
		expect(registryEntry).not.toContain("tool-bash");
	});

	it("prompts through the loader-owned faux, agent, memory session, and print profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-composable-print-"));
		const entryPath = resolve(process.cwd(), "src", "entry.ts");
		try {
			const child = spawn(process.execPath, ["--experimental-strip-types", entryPath, "--print", "hello"], {
				cwd: root,
				env: { ...process.env, DI_CODE_PROVIDER: "faux", DI_CODE_MODEL: "faux-model" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			await once(child, "exit");
			expect(child.exitCode).toBe(0);
			expect(stdout).toBe("Faux response\n");
			expect(stderr).toBe("");
			expect(await readdir(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses the faux agent/session composition in JSON mode and renders versioned events", async () => {
		const root = await mkdtemp(join(tmpdir(), "di-code-composable-json-"));
		const entryPath = resolve(process.cwd(), "src", "entry.ts");
		try {
			const child = spawn(process.execPath, ["--experimental-strip-types", entryPath, "--mode", "json", "hello"], {
				cwd: root,
				env: { ...process.env, DI_CODE_PROVIDER: "faux", DI_CODE_MODEL: "faux-model" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			await once(child, "exit");
			const records = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { version: number; event: { type: string } });
			expect(child.exitCode).toBe(0);
			expect(records.every((record) => record.version === 2)).toBe(true);
			expect(records.at(-1)?.event.type).toBe("agent_end");
			expect(stderr).toBe("");
			expect(await readdir(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("starts with no tools and returns the stable tool_unavailable result", async () => {
		await withFauxEnvironment(async () => {
			const context = createRootContext({ id: "no-tools", mode: "test", trustedProject: true });
			const loader = createCompositionLoader({
				context,
				entries: minimalEntries({
					responses: [
						{
							type: "success",
							content: [{ type: "tool_call", id: "missing-1", name: "missing", arguments: {} }],
						},
						{ type: "success", content: [{ type: "text", text: "recovered" }] },
					],
				}),
				importModule: async (name) => {
					const plugin = modules.get(name);
					if (!plugin) throw new Error(`Unexpected module ${name}`);
					return plugin;
				},
			});
			try {
				await loader.load();
				expect(context.require(toolRegistryKey).snapshot()).toEqual([]);
				const loop = context.require(agentLoopKey);
				await expect(loop.prompt("use missing")).resolves.toMatchObject({ stopReason: "stop" });
				const result = loop.agent.transcript.find(
					(message) => message.role === "tool_result" && message.toolCallId === "missing-1",
				);
				expect(result).toMatchObject({
					isError: true,
					content: [{ type: "text", text: "tool_unavailable: missing" }],
					details: { code: "tool_unavailable" },
				});
			} finally {
				await loader.dispose();
				await context.dispose();
			}
		});
	});

	it("loads only read and isolates session-plugin state across isolated contexts", async () => {
		await withFauxEnvironment(async () => {
			const imported: string[] = [];
			const context = createRootContext({ id: "read-only", mode: "test", trustedProject: true });
			const loader = createCompositionLoader({
				context,
				entries: minimalEntries({ responses: [{ type: "success", content: [{ type: "text", text: "ok" }] }] }, true),
				importModule: async (name) => {
					imported.push(name);
					const plugin = modules.get(name);
					if (!plugin) throw new Error(`Unexpected module ${name}`);
					return plugin;
				},
			});
			const sessionStateKey = createServiceKey<{ readonly id: string }>("isolated-session-state");
			const sessionPlugin: PluginDefinition<{ readonly id: string }> = {
				name: "session-plugin",
				apply: (child, config) => child.set(sessionStateKey, { id: config.id }),
			};
			try {
				await loader.load();
				expect(
					context
						.require(toolRegistryKey)
						.snapshot()
						.map((tool) => tool.name),
				).toEqual(["read"]);
				expect(imported).toContain("tool-read");
				expect(imported).not.toContain("tool-write");
				expect(imported).not.toContain("tool-edit");
				expect(imported).not.toContain("tool-bash");

				const first = context.child({ id: "session-one", isolate: true });
				const second = context.child({ id: "session-two", isolate: true });
				await first.plugin(sessionPlugin, { id: "one" });
				await second.plugin(sessionPlugin, { id: "two" });
				expect(first.require(sessionStateKey)).toEqual({ id: "one" });
				expect(second.require(sessionStateKey)).toEqual({ id: "two" });
				expect(context.get(sessionStateKey)).toBeUndefined();
			} finally {
				await loader.dispose();
				await context.dispose();
			}
		});
	});

	it("loads two providers but sends the prompt only to the selected factory", async () => {
		await withFauxEnvironment(async () => {
			let selectedRequests = 0;
			let unselectedRequests = 0;
			const createProviderPlugin = (id: "faux" | "alternate", count: () => void): PluginDefinition => ({
				name: `provider-${id}`,
				apply: (current) => {
					const faux = createFauxProvider({
						responses: [{ type: "success", content: [{ type: "text", text: `${id}-response` }] }],
					});
					const provider: Provider = {
						...faux.provider,
						id,
						stream(model, providerContext, options) {
							count();
							return faux.provider.stream(model, providerContext, options);
						},
					};
					current.require(providerRegistryKey).register({ provider, model: { ...faux.model, provider: id } });
				},
			});
			const selected = createProviderPlugin("faux", () => {
				selectedRequests += 1;
			});
			const alternate = createProviderPlugin("alternate", () => {
				unselectedRequests += 1;
			});
			const context = createRootContext({ id: "two-providers", mode: "test", trustedProject: true });
			const entries = minimalEntries({}).flatMap((item) =>
				item.id === "runtime-selection"
					? [{ ...item }, { id: "provider-alternate", name: "alternate", dependsOn: ["provider-registry"] }]
					: item.id === "provider-faux"
						? [{ ...item, name: "selected" }]
						: [item],
			);
			const loader = createCompositionLoader({
				context,
				entries,
				importModule: async (name) => {
					if (name === "selected") return namespaceModule(selected);
					if (name === "alternate") return namespaceModule(alternate);
					const plugin = modules.get(name);
					if (!plugin) throw new Error(`Unexpected module ${name}`);
					return plugin;
				},
			});
			try {
				await loader.load();
				await context.require(agentLoopKey).prompt("selected only");
				expect(selectedRequests).toBe(1);
				expect(unselectedRequests).toBe(0);
			} finally {
				await loader.dispose();
				await context.dispose();
			}
		});
	});

	it("starts and stops interactive presentation through a virtual terminal", () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new Text("composition-ready"));
		tui.start();
		tui.stop();
		expect(terminal.output).toContain("composition-ready");
		expect(terminal.output).toContain("show");
	});
});
