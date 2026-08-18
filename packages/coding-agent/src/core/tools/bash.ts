import { spawn } from "node:child_process";
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

export type BashTool = AgentTool<typeof bashParameters, ToolResultContent[]>;

export interface ShellRuntime {
	readonly executable: string;
	readonly detached: boolean;
	readonly description: string;
	args(command: string): readonly string[];
}

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

function createPowerShellScript(command: string): string {
	return [
		"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		"$script:diCodeSucceeded = $false",
		"$script:diCodeExitCode = 0",
		"& {",
		command,
		"$script:diCodeSucceeded = $?",
		"$script:diCodeExitCode = $LASTEXITCODE",
		"} | Out-Default",
		"if ($script:diCodeSucceeded) { exit 0 }",
		"if ($script:diCodeExitCode -is [int] -and $script:diCodeExitCode -ne 0) { exit $script:diCodeExitCode }",
		"exit 1",
	].join("\n");
}

export function resolveShellRuntime(platform: NodeJS.Platform = process.platform): ShellRuntime {
	if (platform === "win32") {
		return {
			executable: "powershell.exe",
			detached: false,
			description:
				"Execute a Windows PowerShell command in the allowed root with timeout and bounded output. Use PowerShell syntax such as Get-ChildItem and Get-Content; do not use Bash syntax.",
			args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", createPowerShellScript(command)],
		};
	}

	return {
		executable: "/bin/sh",
		detached: true,
		description:
			"Execute a POSIX shell command using /bin/sh in the allowed root with timeout and bounded output. Use portable POSIX syntax; Bash-only extensions may not be available.",
		args: (command) => ["-c", command],
	};
}

function waitForProcess(command: string, cwd: string, options: BashRunOptions): Promise<BashExecution> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const runtime = resolveShellRuntime();
		const child = spawn(runtime.executable, [...runtime.args(command)], {
			cwd,
			detached: runtime.detached,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
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
	const runtime = resolveShellRuntime();
	assertMaxOutputBytes(maxOutputBytes);

	return {
		name: "bash",
		description: runtime.description,
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
