import type { AssistantMessage } from "@di-code/ai";

export interface PrintIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

export interface PromptRunner {
	prompt(text: string): Promise<AssistantMessage>;
}

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function textContent(message: AssistantMessage): string {
	return message.content
		.filter(
			(content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text",
		)
		.map((content) => content.text)
		.join("");
}

export async function runPrintMode(prompt: string, runner: PromptRunner, io: PrintIo): Promise<number> {
	try {
		const assistant = await runner.prompt(prompt);
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			io.stderr(`${assistant.errorMessage}\n`);
			return 1;
		}

		const text = textContent(assistant);
		if (text.length > 0) {
			io.stdout(`${text}\n`);
		}
		return 0;
	} catch (cause) {
		io.stderr(`${toError(cause).message}\n`);
		return 1;
	}
}
