import type { Message } from "@di-code/ai";
import type { AgentSessionEvent, SessionUsage } from "../core/session.ts";
import { computeEditsDiff, type Edit } from "../core/tools/edit-diff.ts";

export type InteractiveMessage =
	| { readonly role: "user" | "assistant"; readonly text: string }
	| {
			readonly role: "file_change";
			readonly id: string;
			readonly path: string;
			readonly kind: "edit" | "write";
			readonly removed: readonly string[];
			readonly added: readonly string[];
			readonly diff?: string;
			readonly firstChangedLine?: number;
	  };

type FileChangeCandidate = Extract<InteractiveMessage, { role: "file_change" }>;

export type InteractiveProcessItem =
	| { readonly type: "thinking"; readonly id: "thinking" }
	| {
			readonly type: "tool";
			readonly id: string;
			readonly command: string;
			readonly status: "running" | "done" | "error";
	  };

export interface InteractiveState {
	readonly messages: readonly string[];
	readonly messageItems: readonly InteractiveMessage[];
	readonly processItems: readonly InteractiveProcessItem[];
	readonly spinnerFrame: number;
	readonly streamingText: string;
	readonly toolStatus: readonly string[];
	readonly busy: boolean;
	readonly error?: string;
	readonly queue: readonly string[];
	readonly status?: string;
	readonly compacting: boolean;
	readonly retrying: boolean;
	readonly usage: SessionUsage;
}

function textOf(message: Message): string {
	type TextBlock = Extract<Message["content"][number], { type: "text" }>;
	return message.content
		.filter((content): content is TextBlock => content.type === "text")
		.map((content) => content.text)
		.join("");
}

export class InteractiveProjection {
	private readonly messages: string[] = [];
	private readonly messageItems: InteractiveMessage[] = [];
	private readonly pendingFileChanges = new Map<string, FileChangeCandidate>();
	private readonly processItems: InteractiveProcessItem[] = [];
	private readonly toolStatus = new Map<string, string>();
	private spinnerFrame = 0;
	private streamingText = "";
	private busy = false;
	private error: string | undefined;
	private queue: string[] = [];
	private status: string | undefined;
	private compacting = false;
	private retrying = false;
	private previewRoot: string | undefined;
	private previewChange: (() => void) | undefined;
	private usage: SessionUsage = {
		requestCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		estimatedContextTokens: 0,
		contextWindow: 0,
		reserveTokens: 0,
		triggerTokens: 0,
	};

	get state(): InteractiveState {
		const visibleMessageItems = [...this.messageItems, ...this.pendingFileChanges.values()];
		return {
			messages: [...this.messages],
			messageItems: visibleMessageItems.map((message) =>
				message.role === "file_change"
					? { ...message, removed: [...message.removed], added: [...message.added] }
					: { ...message },
			),
			processItems: this.processItems.map((item) => ({ ...item })),
			spinnerFrame: this.spinnerFrame,
			streamingText: this.streamingText,
			toolStatus: [...this.toolStatus.values()],
			busy: this.busy,
			error: this.error,
			queue: [...this.queue],
			status: this.status,
			compacting: this.compacting,
			retrying: this.retrying,
			usage: { ...this.usage, cost: { ...this.usage.cost } },
		};
	}

	setError(message: string | undefined): void {
		this.error = message;
	}

	clearVisibleMessages(): void {
		this.messages.length = 0;
		this.messageItems.length = 0;
		this.pendingFileChanges.clear();
		this.streamingText = "";
		this.processItems.length = 0;
		this.toolStatus.clear();
		this.error = undefined;
	}

	setQueue(queue: readonly string[]): void {
		this.queue = [...queue];
	}

	setStatus(status: string | undefined): void {
		this.status = status;
	}

	setCompacting(value: boolean): void {
		this.compacting = value;
	}

	setRetrying(value: boolean): void {
		this.retrying = value;
	}

	setUsage(usage: SessionUsage): void {
		this.usage = structuredClone(usage);
	}

	configureFilePreview(root: string, onChange: () => void): void {
		this.previewRoot = root;
		this.previewChange = onChange;
	}

	advanceSpinner(): boolean {
		if (!this.busy) return false;
		this.spinnerFrame = (this.spinnerFrame + 1) % 4;
		return true;
	}

	clearTransientProcess(): void {
		this.processItems.length = 0;
		this.toolStatus.clear();
		this.spinnerFrame = 0;
	}

	replaceTranscript(messages: readonly Message[]): void {
		this.messages.length = 0;
		this.messageItems.length = 0;
		this.pendingFileChanges.clear();
		this.processItems.length = 0;
		this.toolStatus.clear();
		this.spinnerFrame = 0;
		this.streamingText = "";
		this.busy = false;
		this.error = undefined;
		for (const message of messages) this.appendCompletedMessage(message);
	}

	apply(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.error = undefined;
				this.retrying = false;
				this.processItems.length = 0;
				this.processItems.push({ type: "thinking", id: "thinking" });
				this.toolStatus.clear();
				this.spinnerFrame = 0;
				return;
			case "compaction_start":
				this.compacting = true;
				return;
			case "compaction_end":
				this.compacting = false;
				if (!event.success) this.error = event.errorMessage;
				return;
			case "usage_update":
				this.setUsage(event.usage);
				return;
			case "queue_update":
			case "tree_navigated":
				return;
			case "message_start":
				if (event.message.role === "assistant") this.streamingText = "";
				return;
			case "message_update":
				if (event.event.type === "text_delta") {
					if (event.event.delta.length > 0) this.removeThinking();
					this.streamingText += event.event.delta;
				}
				return;
			case "tool_execution_start":
				this.removeThinking();
				this.processItems.push({
					type: "tool",
					id: event.toolCallId,
					command: formatToolCommand(event.toolName, event.arguments),
					status: "running",
				});
				this.toolStatus.set(event.toolCallId, `${event.toolName}: running`);
				this.storeFileChange(event.toolCallId, event.toolName, event.arguments);
				return;
			case "tool_execution_end":
				this.updateToolStatus(event.toolCallId, event.result.isError ? "error" : "done");
				this.toolStatus.set(event.toolCallId, `${event.toolName}: ${event.result.isError ? "error" : "done"}`);
				this.commitFileChange(event.toolCallId, event.result.isError, event.result.details);
				return;
			case "message_end":
				this.appendCompletedMessage(event.message);
				return;
			case "agent_end":
				this.busy = false;
				this.retrying = false;
				this.pendingFileChanges.clear();
				this.processItems.length = 0;
				this.toolStatus.clear();
				this.spinnerFrame = 0;
				return;
			case "turn_start":
				if (this.busy && !this.processItems.some((item) => item.type === "thinking")) {
					this.processItems.push({ type: "thinking", id: "thinking" });
					this.spinnerFrame = 0;
				}
				return;
			case "turn_end":
				return;
		}
	}

	private removeThinking(): void {
		const index = this.processItems.findIndex((item) => item.type === "thinking");
		if (index >= 0) this.processItems.splice(index, 1);
	}

	private updateToolStatus(id: string, status: "done" | "error"): void {
		const index = this.processItems.findIndex((item) => item.type === "tool" && item.id === id);
		const item = this.processItems[index];
		if (index < 0 || item?.type !== "tool") return;
		this.processItems[index] = { ...item, status };
	}

	private appendCompletedMessage(message: Message): void {
		if (message.role === "tool_result") {
			this.commitFileChange(message.toolCallId, message.isError, message.details);
			return;
		}
		const text = textOf(message);
		if (message.role === "user") {
			if (text.length > 0) {
				this.messages.push(text);
				this.messageItems.push({ role: "user", text });
			}
			return;
		}
		if (text.length > 0 && message.stopReason !== "tool_use") {
			this.messages.push(text);
			this.messageItems.push({ role: "assistant", text });
		}
		for (const content of message.content) {
			if (content.type === "tool_call") this.storeFileChange(content.id, content.name, content.arguments);
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") this.error = message.errorMessage;
		this.streamingText = "";
	}

	private storeFileChange(id: string, toolName: string, argumentsValue: Record<string, unknown>): void {
		const path = argumentsValue.path;
		if (typeof path !== "string") return;
		if (toolName === "edit") {
			const edits = parseEditArguments(argumentsValue);
			if (!edits) return;
			const fallback = edits.flatMap((edit) => ({
				removed: edit.oldText.replaceAll("\r\n", "\n").split("\n"),
				added: edit.newText.replaceAll("\r\n", "\n").split("\n"),
			}));
			this.pendingFileChanges.set(id, {
				role: "file_change",
				id,
				path,
				kind: "edit",
				removed: fallback.flatMap((edit) => edit.removed),
				added: fallback.flatMap((edit) => edit.added),
			});
			if (this.previewRoot) {
				void computeEditsDiff(path, edits, this.previewRoot).then((preview) => {
					const current = this.pendingFileChanges.get(id);
					if (!current || "error" in preview) return;
					this.pendingFileChanges.set(id, {
						...current,
						diff: preview.diff,
						firstChangedLine: preview.firstChangedLine,
					});
					this.previewChange?.();
				});
			}
		}
		if (toolName === "write" && typeof argumentsValue.content === "string") {
			this.pendingFileChanges.set(id, {
				role: "file_change",
				id,
				path,
				kind: "write",
				removed: [],
				added: argumentsValue.content.replaceAll("\r\n", "\n").split("\n"),
			});
		}
	}

	private commitFileChange(id: string, isError: boolean, details: unknown = undefined): void {
		const change = this.pendingFileChanges.get(id);
		this.pendingFileChanges.delete(id);
		if (!change || isError) return;
		const metadata = isEditDetails(details) ? details : undefined;
		this.messageItems.push(
			metadata ? { ...change, diff: metadata.diff, firstChangedLine: metadata.firstChangedLine } : change,
		);
	}
}

function parseEditArguments(argumentsValue: Record<string, unknown>): Edit[] | undefined {
	if (Array.isArray(argumentsValue.edits)) {
		const edits: Edit[] = [];
		for (const value of argumentsValue.edits) {
			if (!isRecord(value) || typeof value.oldText !== "string" || typeof value.newText !== "string") return undefined;
			edits.push({ oldText: value.oldText, newText: value.newText });
		}
		return edits.length > 0 ? edits : undefined;
	}
	return typeof argumentsValue.oldText === "string" && typeof argumentsValue.newText === "string"
		? [{ oldText: argumentsValue.oldText, newText: argumentsValue.newText }]
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isEditDetails(value: unknown): value is { diff: string; firstChangedLine?: number } {
	return (
		isRecord(value) &&
		typeof value.diff === "string" &&
		(value.firstChangedLine === undefined || typeof value.firstChangedLine === "number")
	);
}

function formatToolCommand(toolName: string, argumentsValue: Record<string, unknown>): string {
	const serialized = JSON.stringify(argumentsValue);
	return serialized === "{}" ? toolName : `${toolName} ${serialized}`;
}
