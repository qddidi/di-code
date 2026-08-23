import { access, writeFile } from "node:fs/promises";
import { type Context, createFauxProvider, type Message, type Model, type Provider } from "@di-code/ai";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import { AgentSession } from "../test-agent-session.ts";

function messageText(message: ReturnType<SessionManager["messages"]["at"]>): string {
	if (!message) return "";
	return message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("");
}

function userMessage(text: string, timestamp: number): Extract<Message, { role: "user" }> {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, timestamp: number): Extract<Message, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "faux",
		model: "small-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
		stopReason: "stop",
	};
}

function smallModel(model: Model): Model {
	return { ...model, id: "small-model", contextWindow: 24, maxOutputTokens: 6 };
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
} else if (action === "compact-write") {
	const manager = await SessionManager.create({ filePath, cwd });
	await manager.appendMessage(userMessage("old-user", 1));
	await manager.appendMessage(assistantMessage("old-asst", 2));
	await manager.appendMessage(userMessage("new-user", 3));
	await manager.appendMessage(assistantMessage("new-asst", 4));
	const faux = createFauxProvider({
		responses: [
			{ type: "success", content: [{ type: "text", text: "compressed" }] },
			{ type: "success", content: [{ type: "text", text: "final" }] },
		],
	});
	const session = new AgentSession({
		allowedRoot: cwd,
		provider: faux.provider,
		model: smallModel(faux.model),
		sessionManager: manager,
		compaction: { keepRecentTokens: 5 },
	});
	await session.prompt("x".repeat(20));
	process.stdout.write(`${JSON.stringify({ sessionFile: session.sessionFile })}\n`);
} else if (action === "compact-read-context") {
	const manager = await SessionManager.open(filePath);
	const diskTexts = manager.messages.map(messageText);
	const faux = createFauxProvider({
		responses: [{ type: "success", content: [{ type: "text", text: "continued" }] }],
	});
	let requestedContext: Context | undefined;
	const provider: Provider = {
		...faux.provider,
		stream(model, context, options) {
			requestedContext = structuredClone(context);
			return faux.provider.stream(model, context, options);
		},
	};
	const session = new AgentSession({
		allowedRoot: cwd,
		provider,
		model: smallModel(faux.model),
		sessionManager: manager,
		compaction: { enabled: false },
	});
	await session.prompt("resumed");
	process.stdout.write(
		`${JSON.stringify({
			diskTexts,
			contextTexts: requestedContext?.messages.map(messageText),
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
