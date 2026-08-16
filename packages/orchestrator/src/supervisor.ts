import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { RpcClient, type RpcEventRecord, type RpcSessionState } from "@di-code/coding-agent/rpc";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_STDERR_LENGTH = 16_384;

export type RpcSupervisorState = "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed";

export interface RpcSpawnConfiguration {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export interface RpcChildProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
}

export interface RpcSupervisorOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly stopTimeoutMs?: number;
	readonly spawnProcess?: (configuration: RpcSpawnConfiguration) => RpcChildProcess;
}

export interface RpcProcessExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

function defaultSpawnProcess(configuration: RpcSpawnConfiguration): RpcChildProcess {
	return spawn(configuration.command, [...configuration.args], {
		cwd: configuration.cwd,
		env: configuration.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

export class RpcSupervisor {
	private readonly configuration: RpcSpawnConfiguration;
	private readonly spawnProcess: (configuration: RpcSpawnConfiguration) => RpcChildProcess;
	private readonly stopTimeoutMs: number;
	private readonly listeners = new Set<(state: RpcSupervisorState) => void>();
	private child?: RpcChildProcess;
	private client?: RpcClient;
	private stateValue: RpcSupervisorState = "idle";
	private lastExitValue?: RpcProcessExit;
	private stderrValue = "";

	constructor(options: RpcSupervisorOptions) {
		this.configuration = {
			command: options.command,
			args: options.args ?? [],
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
		};
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		if (!Number.isInteger(this.stopTimeoutMs) || this.stopTimeoutMs <= 0) {
			throw new RangeError("stopTimeoutMs must be a positive integer");
		}
	}

	get state(): RpcSupervisorState {
		return this.stateValue;
	}

	get lastExit(): RpcProcessExit | undefined {
		return this.lastExitValue ? { ...this.lastExitValue } : undefined;
	}

	get stderr(): string {
		return this.stderrValue;
	}

	subscribe(listener: (state: RpcSupervisorState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeEvents(listener: (event: RpcEventRecord) => void): () => void {
		if (!this.client) throw new Error("RPC supervisor is not started.");
		return this.client.subscribe(listener);
	}

	async start(): Promise<RpcSessionState> {
		if (this.stateValue !== "idle" && this.stateValue !== "stopped") {
			throw new Error(`Cannot start RPC supervisor while it is ${this.stateValue}.`);
		}
		this.stderrValue = "";
		this.lastExitValue = undefined;
		this.setState("starting");
		const child = this.spawnProcess(this.configuration);
		this.child = child;
		child.stderr.on("data", this.handleStderr);
		child.once("exit", this.handleExit);
		child.once("error", this.handleChildError);
		const client = new RpcClient({
			readable: child.stdout,
			writable: child.stdin,
			onExit: (listener) => {
				child.on("exit", listener);
				return () => child.off("exit", listener);
			},
		});
		this.client = client;
		try {
			const state = await client.getState();
			if (this.child !== child || !this.hasState("starting")) {
				throw new Error("RPC process exited during startup.");
			}
			this.setState("running");
			return state;
		} catch (cause) {
			if (this.hasState("starting")) {
				this.setState("crashed");
				child.kill("SIGTERM");
			}
			throw cause;
		}
	}

	getState(): Promise<RpcSessionState> {
		return this.requireRunningClient().getState();
	}

	prompt(message: string, options: { readonly signal?: AbortSignal } = {}): ReturnType<RpcClient["prompt"]> {
		return this.requireRunningClient().prompt(message, options);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child || this.stateValue === "idle" || this.stateValue === "stopped") {
			this.client?.close();
			this.setState("stopped");
			return;
		}
		if (this.stateValue === "crashed") {
			this.client?.close();
			this.detachChild(child);
			this.setState("stopped");
			return;
		}
		if (this.stateValue === "stopping") throw new Error("RPC supervisor is already stopping.");

		this.setState("stopping");
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGTERM");
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timeout = setTimeout(() => resolve("timeout"), this.stopTimeoutMs);
		});
		if ((await Promise.race([exited.then(() => "exit" as const), timedOut])) === "timeout") {
			child.kill("SIGKILL");
			await exited;
		}
		if (timeout) clearTimeout(timeout);
		this.client?.close();
		if (!this.hasState("stopped")) this.setState("stopped");
	}

	private requireRunningClient(): RpcClient {
		if (this.stateValue !== "running" || !this.client) {
			throw new Error(`RPC supervisor is not running (state=${this.stateValue}).`);
		}
		return this.client;
	}

	private hasState(state: RpcSupervisorState): boolean {
		return this.stateValue === state;
	}

	private setState(state: RpcSupervisorState): void {
		if (this.stateValue === state) return;
		this.stateValue = state;
		for (const listener of this.listeners) listener(state);
	}

	private readonly handleStderr = (chunk: string | Buffer): void => {
		this.stderrValue = `${this.stderrValue}${chunk.toString("utf8")}`.slice(-MAX_STDERR_LENGTH);
	};

	private readonly handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		const child = this.child;
		this.lastExitValue = { code, signal };
		if (child) this.detachChild(child);
		this.setState(this.stateValue === "stopping" ? "stopped" : "crashed");
	};

	private readonly handleChildError = (error: Error): void => {
		this.stderrValue = `${this.stderrValue}${error.message}\n`.slice(-MAX_STDERR_LENGTH);
	};

	private detachChild(child: RpcChildProcess): void {
		child.stderr.off("data", this.handleStderr);
		child.off("exit", this.handleExit);
		child.off("error", this.handleChildError);
		if (this.child === child) this.child = undefined;
	}
}
