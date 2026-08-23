import type { RendererDefinition } from "@di-code/builtins";
import { type JsonRenderer, type JsonRunner, runJsonMode } from "./json.ts";
import type { PrintIo } from "./print.ts";

export interface JsonModeEntryOptions {
	readonly prompt: string;
	readonly runner: JsonRunner;
	readonly io: PrintIo;
	readonly renderer?: RendererDefinition;
	readonly onStart: () => void | Promise<void>;
	readonly onStop: () => void | Promise<void>;
}

export async function runJsonModeEntry(options: JsonModeEntryOptions): Promise<number> {
	await options.onStart();
	try {
		const renderer: JsonRenderer | undefined = options.renderer
			? { render: (event) => options.renderer?.render(event) }
			: undefined;
		return await runJsonMode(options.prompt, options.runner, options.io, renderer);
	} finally {
		await options.onStop();
	}
}
