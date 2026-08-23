import type { AgentEvent, AgentListener } from "@di-code/agent";
import type { AssistantMessage } from "@di-code/ai";
import type { PrintIo } from "./print.ts";

export const JSON_EVENT_VERSION = 2 as const;

export interface JsonEventRecord {
	readonly version: typeof JSON_EVENT_VERSION;
	readonly event: AgentEvent;
}

export interface JsonRunner {
	prompt(text: string): Promise<AssistantMessage>;
	subscribe(listener: AgentListener): () => void;
}

export interface JsonRenderer {
	render(event: AgentEvent): string | undefined;
}

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

export async function runJsonMode(
	prompt: string,
	runner: JsonRunner,
	io: PrintIo,
	renderer?: JsonRenderer,
): Promise<number> {
	const unsubscribe = runner.subscribe((event) => {
		const rendered = renderer?.render(event) ?? JSON.stringify({ version: JSON_EVENT_VERSION, event });
		io.stdout(`${rendered}\n`);
	});

	try {
		const assistant = await runner.prompt(prompt);
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			io.stderr(`${assistant.errorMessage}\n`);
			return 1;
		}
		return 0;
	} catch (cause) {
		io.stderr(`${toError(cause).message}\n`);
		return 1;
	} finally {
		unsubscribe();
	}
}
