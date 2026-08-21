import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@di-code/agent";
import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import type { PluginTerminalFrontendHost } from "@di-code/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session/session-manager.ts";
import { workspaceStorageKey } from "../src/core/user-data.ts";
import { formatSessionLabel, runMain, StartupStatusRenderer } from "../src/main.ts";
import { DynamicPluginBroker } from "../src/plugins/dynamic-broker.ts";

function createIo() {
	return { stdout: vi.fn(), stderr: vi.fn() };
}

class FixtureTerminal implements PluginTerminalFrontendHost {
	readonly columns: number;
	readonly rows = 24;
	readonly output: string[] = [];
	starts = 0;
	stops = 0;

	constructor(columns = 80) {
		this.columns = columns;
	}

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.starts++;
		queueMicrotask(() => onInput("submit"));
	}
	stop(): void {
		this.stops++;
	}
	write(data: string): void {
		this.output.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

class LifecycleBroker extends DynamicPluginBroker {
	private readonly lifecycleEvents: string[];

	constructor(options: ConstructorParameters<typeof DynamicPluginBroker>[0], events: string[]) {
		super(options);
		this.lifecycleEvents = events;
	}

	override async emit(event: { readonly type: string }, signal?: AbortSignal): Promise<void> {
		this.lifecycleEvents.push(event.type);
		await super.emit(event, signal);
	}
}

describe("StartupStatusRenderer", () => {
	it("replaces a loading line with its final outcome in an interactive terminal", () => {
		const output: string[] = [];
		const renderer = new StartupStatusRenderer((text) => output.push(text), true, 80);

		renderer.update("plugin:example", "Plugin [loading] example");
		renderer.update("plugin:example", "Plugin [ok] example (1 tools, 0 commands)");

		expect(output).toEqual([
			"Plugin [loading] example\n",
			"\x1b[1A\r\x1b[2KPlugin [ok] example (1 tools, 0 commands)\x1b[1B\r",
		]);
	});

	it("keeps append-only status output when terminal cursor control is unavailable", () => {
		const output: string[] = [];
		const renderer = new StartupStatusRenderer((text) => output.push(text), false, 80);

		renderer.update("mcp:example", "MCP [loading] example");
		renderer.update("mcp:example", "MCP [ok] example (1 tools, 0 resources, 0 prompts)");

		expect(output).toEqual(["MCP [loading] example\n", "MCP [ok] example (1 tools, 0 resources, 0 prompts)\n"]);
	});
});

function createRuntime(responses: readonly FauxResponse[]) {
	const faux = createFauxProvider({ responses });
	return () => ({ provider: faux.provider, model: faux.model });
}

describe("runMain", () => {
	let root: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "di-code-main-"));
		agentDir = join(root, "agent");
	});

	function defaultSessionDirectory(): string {
		return join(agentDir, "sessions", workspaceStorageKey(root));
	}

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("runs a read tool turn through print mode and prints only the final answer", async () => {
		await writeFile(join(root, "print.txt"), "print file content", "utf8");
		const io = createIo();
		const exitCode = await runMain(["--print", "read print.txt"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "main-print-read",
							name: "read",
							arguments: { path: "print.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "Print read completed." }] },
			]),
		});

		expect(exitCode).toBe(0);
		expect(io.stdout).toHaveBeenCalledTimes(1);
		expect(io.stdout).toHaveBeenCalledWith("Print read completed.\n");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("runs a successful read tool turn through versioned JSON mode", async () => {
		await writeFile(join(root, "json.txt"), "json file content", "utf8");
		const io = createIo();
		const exitCode = await runMain(["--mode", "json", "read json.txt"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([
				{
					type: "success",
					content: [
						{
							type: "tool_call",
							id: "main-json-read",
							name: "read",
							arguments: { path: "json.txt" },
						},
					],
				},
				{ type: "success", content: [{ type: "text", text: "JSON read completed." }] },
			]),
		});

		expect(exitCode).toBe(0);
		expect(io.stderr).not.toHaveBeenCalled();
		const records = io.stdout.mock.calls.map(
			([line]) => JSON.parse(line.trim()) as { version: number; event: AgentEvent },
		);
		expect(records.length).toBeGreaterThan(0);
		expect(records.every((record) => record.version === 2)).toBe(true);
		const toolEnd = records
			.map((record) => record.event)
			.find((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => {
				return event.type === "tool_execution_end";
			});
		expect(toolEnd?.result).toMatchObject({
			toolCallId: "main-json-read",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "json file content" }],
		});
		expect(records.map((record) => record.event.type)).toContain("agent_end");
	});

	it.each([
		["print", ["--print", "hello"]],
		["json", ["--mode", "json", "hello"]],
	] as const)("bridges dynamic session lifecycle events through %s mode", async (_mode, args) => {
		const events: string[] = [];
		const io = createIo();
		const exitCode = await runMain(args, {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "done" }] }]),
			createDynamicPluginBroker: (options) => new LifecycleBroker(options, events),
		});

		expect(exitCode).toBe(0);
		expect(events[0]).toBe("session_start");
		expect(events.at(-1)).toBe("session_shutdown");
		expect(events).toContain("agent_start");
	});

	it("runs a selected plugin frontend with controller events, restricted UI data, and terminal cleanup", async () => {
		const pluginRoot = join(root, ".di-code", "plugins", "fixture");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "fixture",
				name: "Fixture",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			`export default (api) => {
				api.registerInteractivePanel({ id: "fixture-status", title: "Fixture status", data: { ready: true } });
				api.registerToolDetailRenderer({ toolName: "fixture__tool", render: (result) => String(result) });
				api.registerInteractiveFrontend({
					id: "fixture",
					displayName: "Fixture terminal",
					capabilities: ["multiline-input", "streaming", "tool-status", "cancel", "retry", "commands", "model-selection", "session-selection", "compaction"],
					create: () => ({
						start: async (controller, terminal) => new Promise((resolve) => {
							const subscription = controller.subscribe((event) => terminal.write(event.type));
							terminal.write("panel:" + controller.ui.panels[0].title);
							terminal.start((input) => {
								if (input !== "submit") return;
								void controller.submit("hello").then(() => {
									subscription.dispose();
									terminal.stop();
									resolve();
								});
							}, () => {});
						}),
						dispose: async () => {}
					})
				});
			};`,
		);
		const terminal = new FixtureTerminal(20);
		const lifecycleEvents: string[] = [];

		expect(
			await runMain(["--trust-project", "--profile", "terminal", "--ui", "fixture"], {
				...createIo(),
				version: "0.0.0",
				allowedRoot: root,
				agentDir,
				createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "done" }] }]),
				createTerminal: () => terminal,
				createDynamicPluginBroker: (options) => new LifecycleBroker(options, lifecycleEvents),
			}),
		).toBe(0);
		expect(terminal.output).toContain("panel:Fixture status");
		expect(terminal.output).toContain("session_event");
		expect(lifecycleEvents[0]).toBe("session_start");
		expect(lifecycleEvents.at(-1)).toBe("session_shutdown");
		expect(lifecycleEvents).toContain("agent_start");
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBeGreaterThanOrEqual(1);
	});

	it("fails selected frontend startup without falling back to the builtin terminal", async () => {
		const terminal = new FixtureTerminal();
		await expect(
			runMain(["--interactive", "--ui", "missing"], {
				...createIo(),
				version: "0.0.0",
				allowedRoot: root,
				agentDir,
				createRuntime: createRuntime([]),
				createTerminal: () => terminal,
			}),
		).rejects.toThrow('Interactive frontend "missing" is not registered');
		expect(terminal.starts).toBe(0);
		expect(terminal.stops).toBe(1);
	});

	it("protects cleanup when a missing frontend follows a plugin disposal failure", async () => {
		const pluginRoot = join(root, ".di-code", "plugins", "cleanup-plugin");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "cleanup-plugin",
				name: "Cleanup plugin",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			`export default (api) => api.effect(() => ({ dispose: () => { throw new Error("plugin cleanup failed"); } }));`,
		);
		const terminal = new FixtureTerminal();
		await expect(
			runMain(["--trust-project", "--interactive", "--ui", "missing"], {
				...createIo(),
				version: "0.0.0",
				allowedRoot: root,
				agentDir,
				createRuntime: createRuntime([]),
				createTerminal: () => terminal,
			}),
		).rejects.toThrow("Interactive startup and cleanup failed");
		expect(terminal.stops).toBe(1);
	});

	it("rejects a custom frontend that cannot provide the core controller actions", async () => {
		const pluginRoot = join(root, ".di-code", "plugins", "incomplete");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "incomplete",
				name: "Incomplete",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			`export default (api) => api.registerInteractiveFrontend({
				id: "incomplete",
				displayName: "Incomplete",
				capabilities: ["streaming"],
				create: () => ({ start: async () => {}, dispose: async () => {} })
			});`,
		);
		const terminal = new FixtureTerminal();

		await expect(
			runMain(["--trust-project", "--interactive", "--ui", "incomplete"], {
				...createIo(),
				version: "0.0.0",
				allowedRoot: root,
				agentDir,
				createRuntime: createRuntime([]),
				createTerminal: () => terminal,
			}),
		).rejects.toThrow("missing required capabilities");
		expect(terminal.starts).toBe(0);
		expect(terminal.stops).toBe(1);
	});

	it("applies trusted project profile plugin IDs through the real startup path", async () => {
		const allowedRoot = join(root, ".di-code", "plugins", "allowed");
		const blockedRoot = join(root, ".di-code", "plugins", "blocked");
		await mkdir(allowedRoot, { recursive: true });
		await mkdir(blockedRoot, { recursive: true });
		for (const [directory, id, text] of [
			[allowedRoot, "allowed", "allowed plugin"],
			[blockedRoot, "blocked", "blocked plugin"],
		] as const) {
			await writeFile(
				join(directory, "plugin.json"),
				JSON.stringify({
					apiVersion: 1,
					id,
					name: id,
					version: "1.0.0",
					entry: "index.mjs",
					permissions: { filesystem: "none", network: [], process: [] },
				}),
			);
			await writeFile(
				join(directory, "index.mjs"),
				`export default (api) => api.registerTool({ name: "${id}__status", description: "status", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => [{ type: "text", text: "${text}" }] });`,
			);
		}
		const io = createIo();
		const exitCode = await runMain(["--trust-project", "--print", "check status"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			startupConfiguration: {
				environment: {},
				providers: [],
				profileOverrides: { project: { pluginIds: ["allowed"] } },
			},
			createRuntime: createRuntime([
				{
					type: "success",
					content: [{ type: "tool_call", id: "allowed-call", name: "allowed__status", arguments: {} }],
				},
				{ type: "success", content: [{ type: "text", text: "profile filtered" }] },
			]),
		});
		expect(exitCode).toBe(0);
		expect(io.stdout).toHaveBeenCalledWith("profile filtered\n");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("continues host cleanup when a selected frontend dispose fails", async () => {
		const pluginRoot = join(root, ".di-code", "plugins", "dispose-failure");
		const marker = join(root, "frontend-disposed.txt");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "dispose-failure",
				name: "Dispose failure",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			`import { writeFile } from "node:fs/promises";
			export default (api) => {
				api.effect(() => ({ dispose: () => writeFile(${JSON.stringify(marker)}, "cleaned", "utf8") }));
				api.registerInteractiveFrontend({
					id: "dispose-failure",
					displayName: "Dispose failure",
					capabilities: ["multiline-input", "streaming", "tool-status", "cancel", "retry", "commands", "model-selection", "session-selection", "compaction"],
					create: () => ({ start: async () => {}, dispose: async () => { throw new Error("frontend dispose failed"); } })
				});
			};`,
		);
		const terminal = new FixtureTerminal();

		await expect(
			runMain(["--trust-project", "--interactive", "--ui", "dispose-failure"], {
				...createIo(),
				version: "0.0.0",
				allowedRoot: root,
				agentDir,
				createRuntime: createRuntime([]),
				createTerminal: () => terminal,
			}),
		).rejects.toThrow("Interactive cleanup failed");
		expect(terminal.stops).toBe(1);
		expect(await readFile(marker, "utf8")).toBe("cleaned");
	});

	it("drives the core controller actions from a custom frontend", async () => {
		const pluginRoot = join(root, ".di-code", "plugins", "actions");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "actions",
				name: "Actions",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginRoot, "index.mjs"),
			`export default (api) => {
				api.registerCommand({ name: "actions-command", description: "actions", handler: async () => {} });
				api.registerInteractiveFrontend({
					id: "actions",
					displayName: "Actions",
					capabilities: ["multiline-input", "streaming", "tool-status", "cancel", "retry", "commands", "model-selection", "session-selection", "compaction"],
					create: () => ({
						start: async (controller, terminal) => {
							const pending = controller.submit("cancel me\\nwith two lines");
							controller.cancel();
							await pending;
							await controller.retry();
							await controller.runCommand("actions-command", "");
							controller.selectModel("faux-model");
							await controller.createSession();
							try { await controller.requestCompaction(); } catch (error) { terminal.write("compaction-error:" + String(error)); }
							terminal.write("actions-complete");
						},
						dispose: async () => {}
					})
				});
			};`,
		);
		const terminal = new FixtureTerminal(20);
		const result = await runMain(["--trust-project", "--interactive", "--ui", "actions"], {
			...createIo(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([
				{ type: "success", content: [{ type: "text", text: "cancelled response" }] },
				{ type: "success", content: [{ type: "text", text: "retried response" }] },
			]),
			createTerminal: () => terminal,
		});
		expect(result).toBe(0);
		expect(terminal.output.join("")).toContain("actions-complete");
		expect(terminal.output.join("")).toContain("compaction-error:");
		expect(terminal.stops).toBeGreaterThanOrEqual(1);
	});

	it("sends a CLI image attachment to the provider with its text prompt", async () => {
		await writeFile(join(root, "diagram.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const faux = createFauxProvider({
			responses: [{ type: "success", content: [{ type: "text", text: "diagram described" }] }],
		});
		let requestedContent: import("@di-code/ai").UserContent[] | undefined;
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				context: import("@di-code/ai").Context,
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				const user = context.messages.find((message) => message.role === "user");
				requestedContent = user?.role === "user" ? [...user.content] : undefined;
				return faux.provider.stream(model, context, options);
			},
		};
		const io = createIo();

		const exitCode = await runMain(["--image", "diagram.png", "--print", "describe this diagram"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: () => ({ provider, model: faux.model }),
		});

		expect(exitCode).toBe(0);
		expect(requestedContent).toEqual([
			{ type: "text", text: "describe this diagram" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
		expect(io.stdout).toHaveBeenCalledWith("diagram described\n");
	});

	it("loads trusted project plugin tools into the CLI AgentSession", async () => {
		const pluginDirectory = join(root, ".di-code", "plugins", "project-status");
		await mkdir(pluginDirectory, { recursive: true });
		await writeFile(
			join(pluginDirectory, "plugin.json"),
			JSON.stringify({
				apiVersion: 1,
				id: "project-status",
				name: "Project Status",
				version: "1.0.0",
				entry: "index.mjs",
				permissions: { filesystem: "none", network: [], process: [] },
			}),
		);
		await writeFile(
			join(pluginDirectory, "index.mjs"),
			'export default (api) => api.registerTool({ name: "project-status__status", description: "Return project status", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => [{ type: "text", text: "plugin ready" }] });',
		);
		const io = createIo();
		const exitCode = await runMain(["--trust-project", "--print", "check status"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir: join(root, "agent"),
			createRuntime: createRuntime([
				{
					type: "success",
					content: [{ type: "tool_call", id: "project-status-call", name: "project-status__status", arguments: {} }],
				},
				{ type: "success", content: [{ type: "text", text: "Project plugin completed." }] },
			]),
		});

		expect(exitCode).toBe(0);
		expect(io.stdout).toHaveBeenCalledWith("Project plugin completed.\n");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("loads resource instructions through the CLI startup path", async () => {
		const agentDir = join(root, "agent");
		await writeFile(join(root, "AGENTS.md"), "Use project instructions.", "utf8");
		await mkdir(join(agentDir, "skills", "review"), { recursive: true });
		const skillPath = join(agentDir, "skills", "review", "SKILL.md");
		await writeFile(skillPath, "---\nname: review\ndescription: Review code.\n---\nSkill body", "utf8");
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		let systemPrompt: string | undefined;
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				context: import("@di-code/ai").Context,
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				systemPrompt = context.systemPrompt;
				return faux.provider.stream(model, context, options);
			},
		};
		const io = createIo();

		const exitCode = await runMain(["--print", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: () => ({ provider, model: faux.model }),
		});

		expect(exitCode).toBe(0);
		expect(systemPrompt).toContain("Use project instructions.");
		expect(systemPrompt).toContain(skillPath);
	});

	it("loads an explicitly selected skill body before sending the user request", async () => {
		const agentDir = join(root, "agent");
		await mkdir(join(agentDir, "skills", "review"), { recursive: true });
		await writeFile(
			join(agentDir, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review code.\n---\nInspect tests before suggesting a change.",
			"utf8",
		);
		const faux = createFauxProvider({ responses: [{ type: "success", content: [{ type: "text", text: "answer" }] }] });
		let userText: string | undefined;
		const provider = {
			...faux.provider,
			stream(
				model: typeof faux.model,
				context: import("@di-code/ai").Context,
				options?: Parameters<typeof faux.provider.stream>[2],
			) {
				userText = context.messages
					.filter((message) => message.role === "user")
					.flatMap((message) => message.content)
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n");
				return faux.provider.stream(model, context, options);
			},
		};

		await runMain(["--print", "/skill:review inspect the login flow"], {
			...createIo(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: () => ({ provider, model: faux.model }),
		});

		expect(userText).toContain("Inspect tests before suggesting a change.");
		expect(userText).toContain("inspect the login flow");
	});

	it("rejects an unknown explicitly selected skill before calling the provider", async () => {
		const agentDir = join(root, "agent");
		const createRuntimeMock = vi.fn(createRuntime([{ type: "success", content: [{ type: "text", text: "answer" }] }]));
		const io = createIo();

		const exitCode = await runMain(["--print", "/skill:missing"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntimeMock,
		});

		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith('Unknown skill "missing". No skills are loaded.\n');
	});

	it("reports malformed skill commands without invoking a skill", async () => {
		const io = createIo();

		const exitCode = await runMain(["--print", "/skill review"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir: join(root, "agent"),
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "answer" }] }]),
		});

		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith("Skill command must use /skill:<name> [request].\n");
	});

	it("labels saved sessions with the first user question and its timestamp", async () => {
		const sessionFile = join(root, "label.jsonl");
		const manager = await SessionManager.create({
			filePath: sessionFile,
			cwd: root,
			now: () => Date.parse("2026-08-12T13:00:00.000Z"),
		});
		await manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "  Explain the session flow\nwith a second line  " }],
			timestamp: Date.parse("2026-08-12T13:05:00.000Z"),
		});

		expect(formatSessionLabel(manager, "Asia/Shanghai")).toBe(
			"Explain the session flow with a second line (2026-08-12 21:05)",
		);
	});

	it("preserves help as a no-runtime command", async () => {
		const io = createIo();
		const createRuntime = vi.fn(() => {
			throw new Error("help must not create a runtime");
		});
		const exitCode = await runMain(["--help"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime,
		});

		expect(exitCode).toBe(0);
		expect(createRuntime).not.toHaveBeenCalled();
		expect(io.stdout.mock.calls[0]?.[0]).toContain("Usage: di-code");
		expect(io.stderr).not.toHaveBeenCalled();
	});

	it("does not create a session when interactive provider setup is cancelled", async () => {
		const io = createIo();
		const createRuntime = vi.fn(async () => undefined);

		const exitCode = await runMain(["--interactive"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime,
		});

		expect(exitCode).toBe(0);
		expect(createRuntime).toHaveBeenCalledWith({ kind: "run", mode: "interactive", prompt: "" });
		await expect(readdir(join(agentDir, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("asks once before loading project-local capabilities and persists trust", async () => {
		const agentDir = join(root, "agent");
		await mkdir(join(root, ".agents", "skills"), { recursive: true });
		const promptProjectTrust = vi.fn().mockResolvedValue(true);
		const createRuntime = vi.fn(async () => undefined);
		const options = {
			...createIo(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime,
			isInteractiveTerminal: true,
			promptProjectTrust,
		};

		expect(await runMain(["--interactive"], options)).toBe(0);
		expect(promptProjectTrust).toHaveBeenCalledOnce();
		expect(promptProjectTrust).toHaveBeenCalledWith(root);
		expect(JSON.parse(await readFile(join(agentDir, "trust.json"), "utf8"))).toMatchObject({
			projects: { [root]: true },
		});

		await runMain(["--interactive"], options);
		expect(promptProjectTrust).toHaveBeenCalledOnce();
	});

	it("records a denial and does not prompt in non-interactive modes", async () => {
		const agentDir = join(root, "agent");
		await mkdir(join(root, ".di-code", "plugins"), { recursive: true });
		const promptProjectTrust = vi.fn().mockResolvedValue(false);
		const createRuntime = vi.fn(async () => undefined);

		await runMain(["--interactive"], {
			...createIo(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime,
			isInteractiveTerminal: true,
			promptProjectTrust,
		});
		expect(promptProjectTrust).toHaveBeenCalledOnce();
		expect(JSON.parse(await readFile(join(agentDir, "trust.json"), "utf8"))).toMatchObject({
			projects: { [root]: false },
		});

		const nonInteractivePrompt = vi.fn().mockResolvedValue(true);
		await runMain(["--print", "hello"], {
			...createIo(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir: join(root, "other-agent"),
			createRuntime,
			isInteractiveTerminal: false,
			promptProjectTrust: nonInteractivePrompt,
		});
		expect(nonInteractivePrompt).not.toHaveBeenCalled();
	});

	it("does not prompt when an explicit trust flag is supplied", async () => {
		const promptProjectTrust = vi.fn().mockResolvedValue(false);
		await mkdir(join(root, ".di-code", "plugins"), { recursive: true });

		await runMain(["--trust-project", "--interactive"], {
			...createIo(),
			version: "0.0.0",
			allowedRoot: root,
			agentDir: join(root, "agent"),
			createRuntime: vi.fn(async () => undefined),
			isInteractiveTerminal: true,
			promptProjectTrust,
		});

		expect(promptProjectTrust).not.toHaveBeenCalled();
	});

	it("creates a new persistent session on each default launch", async () => {
		const io = createIo();
		const firstExit = await runMain(["--print", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "first" }] }]),
		});

		expect(firstExit).toBe(0);
		const secondExit = await runMain(["--print", "again"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "second" }] }]),
		});

		expect(secondExit).toBe(0);
		const sessionDirectory = defaultSessionDirectory();
		const sessionFiles = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
		expect(sessionFiles).toHaveLength(2);
		await expect(readdir(join(root, ".di-code", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
		const sessions = await Promise.all(sessionFiles.map((name) => SessionManager.open(join(sessionDirectory, name))));
		expect(sessions.map((session) => session.messages.map((message) => message.role))).toEqual([
			["user", "assistant"],
			["user", "assistant"],
		]);
	});

	it("continues the most recently modified session only when requested", async () => {
		const io = createIo();
		await runMain(["--print", "older"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "older answer" }] }]),
		});
		const sessionDirectory = defaultSessionDirectory();
		const [olderName] = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
		const olderPath = join(sessionDirectory, olderName as string);
		await runMain(["--print", "newer"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "newer answer" }] }]),
		});
		const newerName = (await readdir(sessionDirectory)).find((name) => name.endsWith(".jsonl") && name !== olderName);
		const newerPath = join(sessionDirectory, newerName as string);
		await utimes(olderPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
		await utimes(newerPath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));

		const exitCode = await runMain(["--continue", "--print", "continued"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "continued answer" }] }]),
		});

		expect(exitCode).toBe(0);
		const older = await SessionManager.open(olderPath);
		const newer = await SessionManager.open(newerPath);
		expect(older.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(newer.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("creates a new session when continue has no history to resume", async () => {
		const io = createIo();
		const exitCode = await runMain(["--continue", "--print", "hello"], {
			...io,
			version: "0.0.0",
			allowedRoot: root,
			agentDir,
			createRuntime: createRuntime([{ type: "success", content: [{ type: "text", text: "answer" }] }]),
		});

		expect(exitCode).toBe(0);
		const sessionFiles = (await readdir(defaultSessionDirectory())).filter((name) => name.endsWith(".jsonl"));
		expect(sessionFiles).toHaveLength(1);
	});
});
