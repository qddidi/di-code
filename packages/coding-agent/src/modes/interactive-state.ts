import type { Message } from "@di-code/ai";
import type { AgentSessionEvent } from "../core/session.ts";

export interface InteractiveMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface InteractiveState {
	readonly messages: readonly string[];
	readonly messageItems: readonly InteractiveMessage[];
	readonly streamingText: string;
	readonly toolStatus: readonly string[];
	readonly busy: boolean;
	readonly error?: string;
	readonly queue: readonly string[];
	readonly status?: string;
	readonly compacting: boolean;
	readonly retrying: boolean;
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
	private readonly toolStatus = new Map<string, string>();
	private streamingText = "";
	private busy = false;
	private error: string | undefined;
	private queue: string[] = [];
	private status: string | undefined;
	private compacting = false;
	private retrying = false;

	get state(): InteractiveState {
		return {
			messages: [...this.messages],
			messageItems: this.messageItems.map((message) => ({ ...message })),
			streamingText: this.streamingText,
			toolStatus: [...this.toolStatus.values()],
			busy: this.busy,
			error: this.error,
			queue: [...this.queue],
			status: this.status,
			compacting: this.compacting,
			retrying: this.retrying,
		};
	}

	setError(message: string | undefined): void {
		this.error = message;
	}

	clearVisibleMessages(): void {
		this.messages.length = 0;
		this.messageItems.length = 0;
		this.streamingText = "";
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

	replaceTranscript(messages: readonly Message[]): void {
		this.messages.length = 0;
		this.messageItems.length = 0;
		this.toolStatus.clear();
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
				this.toolStatus.clear();
				return;
			case "compaction_start":
				this.compacting = true;
				return;
			case "compaction_end":
				this.compacting = false;
				if (!event.success) this.error = event.errorMessage;
				return;
			case "message_start":
				if (event.message.role === "assistant") this.streamingText = "";
				return;
			case "message_update":
				if (event.event.type === "text_delta") this.streamingText += event.event.delta;
				return;
			case "tool_execution_start":
				this.toolStatus.set(event.toolCallId, `${event.toolName}: running`);
				return;
			case "tool_execution_end":
				this.toolStatus.set(event.toolCallId, `${event.toolName}: ${event.result.isError ? "error" : "done"}`);
				return;
			case "message_end":
				this.appendCompletedMessage(event.message);
				return;
			case "agent_end":
				this.busy = false;
				this.retrying = false;
				return;
			case "turn_start":
			case "turn_end":
				return;
		}
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
