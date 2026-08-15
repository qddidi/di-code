import type { Message } from "@di-code/ai";
import type { AgentSessionEvent, SessionUsage } from "../core/session.ts";

export interface InteractiveMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

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
		return {
			messages: [...this.messages],
			messageItems: this.messageItems.map((message) => ({ ...message })),
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

	advanceSpinner(): boolean {
		if (!this.busy || !this.processItems.some((item) => item.type === "thinking")) return false;
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
			case "message_start":
				if (event.message.role === "assistant") this.streamingText = "";
				return;
			case "message_update":
				if (event.event.type === "text_delta") {
					this.removeThinking();
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
				return;
			case "tool_execution_end":
				this.updateToolStatus(event.toolCallId, event.result.isError ? "error" : "done");
				this.toolStatus.set(event.toolCallId, `${event.toolName}: ${event.result.isError ? "error" : "done"}`);
				return;
			case "message_end":
				this.appendCompletedMessage(event.message);
				return;
			case "agent_end":
				this.busy = false;
				this.retrying = false;
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
		if (message.role === "tool_result") return;
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
		if (message.stopReason === "error" || message.stopReason === "aborted") this.error = message.errorMessage;
		this.streamingText = "";
	}
}

function formatToolCommand(toolName: string, argumentsValue: Record<string, unknown>): string {
	const serialized = JSON.stringify(argumentsValue);
	return serialized === "{}" ? toolName : `${toolName} ${serialized}`;
}
