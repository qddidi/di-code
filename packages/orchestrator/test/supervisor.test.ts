import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RpcServer, type RpcSession } from "@di-code/coding-agent/rpc";
import { createRootContext } from "@di-code/plugin-runtime";
import { describe, expect, it } from "vitest";
import { orchestratorHost, orchestratorHostKey } from "../src/host-entry.ts";
import { type RpcChildProcess, type RpcSpawnConfiguration, RpcSupervisor } from "../src/supervisor.ts";

type RpcPromptMessage = Awaited<ReturnType<RpcSession["prompt"]>>;

function assistant(stopReason: "stop" | "aborted"): RpcPromptMessage {
	const base = {
		role: "assistant" as const,
		provider: "faux",
		model: "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
	return stopReason === "stop"
		? { ...base, content: [{ type: "text", text: "done" }], stopReason }
		: { ...base, content: [], stopReason, errorMessage: "Request aborted" };
}

class ControlledSession implements RpcSession {
	readonly sessionId = "session-supervised";
	readonly modelId = "faux-model";
	readonly transcript: RpcPromptMessage[] = [];
	isStreaming = false;
	private release?: () => void;

	subscribeSession(): () => void {
		return () => undefined;
	}

	async prompt(_text: string, signal?: AbortSignal): Promise<RpcPromptMessage> {
		this.isStreaming = true;
		await new Promise<void>((resolve) => {
			this.release = resolve;
			if (signal?.aborted) resolve();
			else signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		const message = assistant(signal?.aborted ? "aborted" : "stop");
		this.transcript.push(message);
		this.isStreaming = false;
		return message;
	}

	finish(): void {
		this.release?.();
	}
}

class FakeChild extends EventEmitter implements RpcChildProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly server: RpcServer;
	killed = false;

	constructor(session: RpcSession) {
		super();
		this.server = new RpcServer({ session, input: this.stdin, output: this.stdout });
		this.server.start();
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.killed) return false;
		this.killed = true;
		this.server.stop();
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}

	crash(code = 9): void {
		this.server.stop();
		this.emit("exit", code, null);
	}
}

function setup() {
	const session = new ControlledSession();
	let child: FakeChild | undefined;
	const spawnProcess = (_configuration: RpcSpawnConfiguration): RpcChildProcess => {
		child = new FakeChild(session);
		return child;
	};
	const supervisor = new RpcSupervisor({
		command: "node",
		args: ["rpc-entry.js"],
		cwd: process.cwd(),
		spawnProcess,
	});
	return { supervisor, session, child: () => child };
}

describe("RpcSupervisor", () => {
	it("registers a composition host without exposing coding-agent internals", async () => {
		const context = createRootContext({ id: "orchestrator-host" });
		try {
			await context.plugin(orchestratorHost, undefined);
			const host = context.require(orchestratorHostKey);
			expect(host.create({ command: "node", cwd: process.cwd() })).toBeInstanceOf(RpcSupervisor);
		} finally {
			await context.dispose();
		}
	});

	it("starts, exposes state, delegates prompts, and stops deterministically", async () => {
		const { supervisor, session, child } = setup();
		const states: string[] = [];
		supervisor.subscribe((state) => states.push(state));

		await expect(supervisor.start()).resolves.toMatchObject({ sessionId: "session-supervised" });
		expect(supervisor.state).toBe("running");
		const prompt = supervisor.prompt("hello");
		session.finish();
		await expect(prompt).resolves.toMatchObject({ stopReason: "stop" });
		await supervisor.stop();

		expect(child()?.killed).toBe(true);
		expect(supervisor.state).toBe("stopped");
		expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
	});

	it("marks an unexpected child exit as crashed and rejects an active request", async () => {
		const { supervisor, child } = setup();
		await supervisor.start();
		const prompt = supervisor.prompt("never finishes");
		child()?.stderr.write("fatal child error\n");

		child()?.crash(17);

		await expect(prompt).rejects.toThrow("RPC process exited (code=17 signal=null)");
		expect(supervisor.state).toBe("crashed");
		expect(supervisor.lastExit).toEqual({ code: 17, signal: null });
		expect(supervisor.stderr).toContain("fatal child error");
	});

	it("passes cancellation through to the supervised prompt", async () => {
		const { supervisor } = setup();
		await supervisor.start();
		const controller = new AbortController();
		const prompt = supervisor.prompt("cancel", { signal: controller.signal });

		controller.abort();

		await expect(prompt).resolves.toMatchObject({ stopReason: "aborted" });
		await supervisor.stop();
	});
});
