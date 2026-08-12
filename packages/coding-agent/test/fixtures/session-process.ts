import { access, writeFile } from "node:fs/promises";
import { createFauxProvider } from "@di-code/ai";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import { AgentSession } from "../../src/core/session.ts";

function messageText(message: ReturnType<SessionManager["messages"]["at"]>): string {
	if (!message) return "";
	return message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("");
}

async function waitForFile(filePath: string): Promise<void> {
	while (true) {
		try {
			await access(filePath);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

const [action, filePath, cwd, value, readyFile, gateFile] = process.argv.slice(2);
if (!action || !filePath || !cwd) {
	throw new Error("Usage: session-process.ts <write|read> <filePath> <cwd>");
}

if (action === "write") {
	const manager = await SessionManager.create({ filePath, cwd });
	const faux = createFauxProvider({
		responses: [{ type: "success", content: [{ type: "text", text: "saved-answer" }] }],
	});
	const session = new AgentSession({
		allowedRoot: cwd,
		provider: faux.provider,
		model: faux.model,
		sessionManager: manager,
	});
	await session.prompt("saved-question");
	process.stdout.write(`${JSON.stringify({ sessionFile: session.sessionFile })}\n`);
} else if (action === "read") {
	const manager = await SessionManager.open(filePath);
	process.stdout.write(
		`${JSON.stringify({
			roles: manager.messages.map((message) => message.role),
			texts: manager.messages.map(messageText),
		})}\n`,
	);
} else if (action === "append") {
	if (!value || !readyFile || !gateFile) {
		throw new Error("append requires value, readyFile, and gateFile");
	}
	const manager = await SessionManager.open(filePath);
	await writeFile(readyFile, "ready", "utf8");
	await waitForFile(gateFile);
	try {
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: value }], timestamp: 1 });
		process.stdout.write(`${JSON.stringify({ status: "appended" })}\n`);
	} catch (cause) {
		const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
		process.stdout.write(`${JSON.stringify({ status: "rejected", code })}\n`);
		process.exitCode = 2;
	}
} else {
	throw new Error(`Unknown action: ${action}`);
}
