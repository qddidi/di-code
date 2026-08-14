import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@di-code/agent";
import { type Static, type ToolResultContent, Type } from "@di-code/ai";

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MAX_BASH_TIMEOUT_MS = 300_000;
export const DEFAULT_BASH_MAX_OUTPUT_BYTES = 50 * 1024;

export const bashParameters = Type.Object({
	command: Type.String({ minLength: 1 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BASH_TIMEOUT_MS })),
});

export type BashParameters = Static<typeof bashParameters>;

export interface BashRunOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
	readonly onStdout: (chunk: Buffer) => void;
	readonly onStderr: (chunk: Buffer) => void;
}

export interface BashExecution {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
}

export interface BashOperations {
	run(command: string, cwd: string, options: BashRunOptions): Promise<BashExecution>;
}

export interface BashToolOptions {
	readonly operations?: BashOperations;
	readonly maxOutputBytes?: number;
}

export type BashTool = AgentTool<typeof bashParameters>;

interface OutputSnapshot {
	readonly text: string;
	readonly truncated: boolean;
}

interface BashStatus {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
}

function assertTimeout(timeoutMs: number): void {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BASH_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be an integer between 1 and ${MAX_BASH_TIMEOUT_MS}`);
	}
}

function assertMaxOutputBytes(maxOutputBytes: number): void {
	if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
		throw new Error("maxOutputBytes must be a positive integer");
	}
}

function createOutputCapture(maxBytes: number): {
	append(chunk: Buffer): void;
	snapshot(): OutputSnapshot;
} {
	const chunks: Buffer[] = [];
	let bytes = 0;
	let truncated = false;

	return {
		append(chunk) {
			const remaining = maxBytes - bytes;
			if (remaining > 0) {
				const kept = chunk.subarray(0, remaining);
				chunks.push(Buffer.from(kept));
				bytes += kept.length;
			}
			if (chunk.length > remaining) truncated = true;
		},
		snapshot() {
			const decoder = new StringDecoder("utf8");
			return { text: decoder.write(Buffer.concat(chunks, bytes)), truncated };
		},
	};
}

function resolveBashShell(): string {
	if (process.platform !== "win32") return "/bin/bash";

	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const candidates = [
		process.env.DI_CODE_BASH_PATH,
		programFiles ? `${programFiles}\\Git\\bin\\bash.exe` : undefined,
		programFiles ? `${programFiles}\\Git\\usr\\bin\\bash.exe` : undefined,
		programFilesX86 ? `${programFilesX86}\\Git\\bin\\bash.exe` : undefined,
	].filter((path): path is string => typeof path === "string" && path.length > 0);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	try {
		const result = spawnSync("where", ["bash.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true });
		const path = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
		if (path && existsSync(path)) return path;
	} catch {
		// The explicit error below explains how to install or configure Bash.
	}
	throw new Error(
		"No Bash shell found on Windows. Install Git for Windows, add bash.exe to PATH, or set DI_CODE_BASH_PATH.",
	);
}

function waitForProcess(command: string, cwd: string, options: BashRunOptions): Promise<BashExecution> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const shell = resolveBashShell();
		const args = ["-c", command];
		const child = spawn(shell, args, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: false,
		});

		let timedOut = false;
		let aborted = false;
		let settled = false;
		let termination: Promise<void> | undefined;

		const requestTermination = (): void => {
			if (child.pid !== undefined) termination ??= killProcessTree(child.pid, child);
		};
		const onAbort = (): void => {
			aborted = true;
			requestTermination();
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			requestTermination();
		}, options.timeoutMs);

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		child.stdout.on("data", options.onStdout);
		child.stderr.on("data", options.onStderr);

		const cleanup = (): void => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
		};
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			settled = true;
			cleanup();
			void (termination ?? Promise.resolve()).then(
				() => resolve({ exitCode, timedOut, aborted }),
				(error: unknown) => reject(error),
			);
		});
	});
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve) => {
		child.once("error", () => resolve());
		child.once("close", () => resolve());
	});
}

async function killProcessTree(pid: number, child: ReturnType<typeof spawn>): Promise<void> {
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		await waitForChild(killer);
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// The process already exited between the timeout and termination request.
		}
	}
}

export function createLocalBashOperations(): BashOperations {
	return { run: waitForProcess };
}

function formatResult(stdout: OutputSnapshot, stderr: OutputSnapshot, execution: BashExecution): string {
	const status: BashStatus = {
		exitCode: execution.exitCode,
		timedOut: execution.timedOut,
		aborted: execution.aborted,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
	};
	return `stdout:\n${stdout.text || "(empty)"}\n\nstderr:\n${stderr.text || "(empty)"}\n\nstatus: ${JSON.stringify(status)}`;
}

export function createBashTool(allowedRoot: string, options: BashToolOptions = {}): BashTool {
	const operations = options.operations ?? createLocalBashOperations();
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_BASH_MAX_OUTPUT_BYTES;
	assertMaxOutputBytes(maxOutputBytes);

	return {
		name: "bash",
		description: "Execute a shell command in the allowed root with timeout and bounded output.",
		parameters: bashParameters,
		async execute(_toolCallId, parameters, signal): Promise<ToolResultContent[]> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (parameters.command.length === 0) throw new Error("command must not be empty");
			const timeoutMs = parameters.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
			assertTimeout(timeoutMs);
			const cwd = await realpath(allowedRoot);
			if (signal?.aborted) throw new Error("Operation aborted");

			const stdout = createOutputCapture(maxOutputBytes);
			const stderr = createOutputCapture(maxOutputBytes);
			const executionResult = await operations.run(parameters.command, cwd, {
				signal,
				timeoutMs,
				onStdout: (chunk) => stdout.append(chunk),
				onStderr: (chunk) => stderr.append(chunk),
			});
			const execution = signal?.aborted ? { ...executionResult, aborted: true } : executionResult;
			const output = formatResult(stdout.snapshot(), stderr.snapshot(), execution);

			if (execution.aborted) throw new Error(`Command aborted\n\n${output}`);
			if (execution.timedOut) throw new Error(`Command timed out after ${timeoutMs} ms\n\n${output}`);
			if (execution.exitCode !== 0) {
				throw new Error(`Command exited with code ${execution.exitCode ?? "unknown"}\n\n${output}`);
			}
			return [{ type: "text", text: output }];
		},
	};
}
