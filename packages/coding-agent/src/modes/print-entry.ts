import type { PrintIo, PromptRunner } from "./print.ts";
import { runPrintMode } from "./print.ts";

export interface PrintModeEntryOptions {
	readonly prompt: string;
	readonly runner: PromptRunner;
	readonly io: PrintIo;
	readonly onStart: () => void | Promise<void>;
	readonly onStop: () => void | Promise<void>;
}

export async function runPrintModeEntry(options: PrintModeEntryOptions): Promise<number> {
	await options.onStart();
	try {
		return await runPrintMode(options.prompt, options.runner, options.io);
	} finally {
		await options.onStop();
	}
}
