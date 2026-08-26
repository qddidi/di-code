import { useCallback, useEffect, useRef, useState } from "react";
import { callRpc, eventHeaders, loadSessions, rememberClient, uploadAttachment } from "./api.ts";
import type {
	AttachmentInfo,
	ContextFile,
	ConversationMessage,
	OperationState,
	SessionSummary,
	ToolApproval,
	ToolTrace,
	UsageSnapshot,
} from "./types.ts";

interface WireEvent {
	readonly sequence?: number;
	readonly requestId: string;
	readonly event: Record<string, unknown>;
}

export interface ConversationState {
	readonly sessions: readonly SessionSummary[];
	readonly activeSessionId?: string;
	readonly messages: readonly ConversationMessage[];
	readonly tools: readonly ToolTrace[];
	readonly approvals: readonly ToolApproval[];
	readonly contextFiles: readonly ContextFile[];
	readonly compaction?: {
		readonly state: "running" | "success" | "error";
		readonly reason: string;
		readonly error?: string;
	};
	readonly usage?: UsageSnapshot;
	readonly operation?: OperationState;
	readonly attachments: readonly AttachmentInfo[];
	readonly connected: boolean;
	readonly error?: string;
	readonly send: (text: string) => Promise<void>;
	readonly steer: (text: string) => Promise<void>;
	readonly cancel: () => Promise<void>;
	readonly compact: () => Promise<void>;
	readonly retry: () => Promise<void>;
	readonly newSession: () => Promise<void>;
	readonly openSession: (id: string) => Promise<void>;
	readonly addFiles: (files: FileList | readonly File[]) => Promise<void>;
	readonly removeAttachment: (id: string) => void;
	readonly approveTool: (approvalId: string, approved: boolean) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			const block = asRecord(item);
			return block?.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

function toolStatus(output: string, isError: boolean, details?: Record<string, unknown>): ToolTrace["status"] {
	if (details?.truncated === true) return "truncated";
	if (!isError) return "success";
	const normalized = output.toLowerCase();
	if (normalized.includes("timed out")) return "timeout";
	if (normalized.includes("aborted") || normalized.includes("cancelled")) return "cancelled";
	return "error";
}

function messagesFromTranscript(transcript: unknown): { messages: ConversationMessage[]; tools: ToolTrace[] } {
	if (!Array.isArray(transcript)) return { messages: [], tools: [] };
	const tools: ToolTrace[] = [];
	const messages = transcript.flatMap((value) => {
		const message = asRecord(value);
		if (!message || (message.role !== "user" && message.role !== "assistant" && message.role !== "tool_result"))
			return [];
		const thinking = Array.isArray(message.content)
			? message.content
					.map((item) => {
						const block = asRecord(item);
						return block?.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "";
					})
					.join("")
			: "";
		if (message.role === "tool_result") {
			const id = typeof message.toolCallId === "string" ? message.toolCallId : crypto.randomUUID();
			const tool = {
				id,
				name: typeof message.toolName === "string" ? message.toolName : "tool",
				arguments: {},
				output: textFromContent(message.content),
				...(asRecord(message.details) ? { details: asRecord(message.details) } : {}),
				status: toolStatus(textFromContent(message.content), message.isError === true, asRecord(message.details)),
			} as ToolTrace;
			const previous = tools.findIndex((item) => item.id === id);
			if (previous === -1) tools.push(tool);
			else
				tools[previous] = {
					...tools[previous],
					...tool,
					status: toolStatus(tool.output ?? "", message.isError === true, tool.details),
				};
			return [];
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				const block = asRecord(item);
				if (block?.type === "tool_call" && typeof block.id === "string" && typeof block.name === "string")
					tools.push({ id: block.id, name: block.name, arguments: asRecord(block.arguments) ?? {}, status: "loading" });
			}
		}
		return [
			{
				role: message.role as "user" | "assistant",
				text: textFromContent(message.content),
				...(thinking ? { thinking } : {}),
			},
		];
	});
	return { messages, tools };
}

async function dataUrlFor(file: File): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (typeof reader.result !== "string") return reject(new Error("Unable to read attachment."));
			const comma = reader.result.indexOf(",");
			if (comma === -1) return reject(new Error("Unable to encode attachment."));
			resolvePromise(reader.result.slice(comma + 1));
		});
		reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read attachment.")));
		reader.readAsDataURL(file);
	});
}

async function readAllPages(): Promise<{ messages: ConversationMessage[]; tools: ToolTrace[] }> {
	const transcript: unknown[] = [];
	let pageToken: string | undefined;
	do {
		const result = await callRpc<{ readonly transcript: unknown[]; readonly nextPageToken?: string }>(
			"get_transcript",
			{
				pageSize: 200,
				maxBytes: 4 * 1024 * 1024,
				...(pageToken ? { pageToken } : {}),
			},
		);
		transcript.push(...result.transcript);
		pageToken = result.nextPageToken;
	} while (pageToken);
	return messagesFromTranscript(transcript);
}

export function useConversation(ready: boolean): ConversationState {
	const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string>();
	const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
	const [tools, setTools] = useState<readonly ToolTrace[]>([]);
	const [approvals, setApprovals] = useState<readonly ToolApproval[]>([]);
	const [contextFiles, setContextFiles] = useState<readonly ContextFile[]>([]);
	const [compaction, setCompaction] = useState<ConversationState["compaction"]>();
	const [usage, setUsage] = useState<UsageSnapshot>();
	const [operation, setOperation] = useState<OperationState>();
	const [attachments, setAttachments] = useState<readonly AttachmentInfo[]>([]);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string>();
	const sequence = useRef(0);
	const resumeToken = useRef<string | undefined>(undefined);
	const stopped = useRef(false);

	const refresh = useCallback(async () => {
		// The first request establishes the actor identity before the parallel snapshot reads begin.
		const stateResult = await callRpc<{ readonly state: { readonly sessionId: string; readonly sequence?: number } }>(
			"get_state",
		);
		const [sessionResult, transcript, usageResult, contextResult] = await Promise.all([
			loadSessions(),
			readAllPages(),
			callRpc<{ readonly usage: UsageSnapshot }>("get_usage"),
			callRpc<{ readonly files: readonly ContextFile[] }>("list_context_files").catch(() => ({ files: [] })),
		]);
		setSessions(sessionResult.sessions);
		setActiveSessionId(stateResult.state.sessionId === "uninitialized" ? undefined : stateResult.state.sessionId);
		sequence.current = Math.max(sequence.current, stateResult.state.sequence ?? 0);
		setMessages(transcript.messages);
		setTools(transcript.tools);
		setContextFiles(contextResult.files);
		setUsage(usageResult.usage);
	}, []);

	const handleEvent = useCallback(
		(record: WireEvent) => {
			if (record.sequence !== undefined) {
				if (record.sequence <= sequence.current) return;
				sequence.current = record.sequence;
			}
			const type = record.event.type;
			if (type === "snapshot_required" || type === "session_changed") {
				void refresh().catch((cause: unknown) =>
					setError(cause instanceof Error ? cause.message : "Unable to restore conversation."),
				);
				return;
			}
			if (type === "operation_update") {
				const next = asRecord(record.event.operation);
				if (
					next &&
					typeof next.requestId === "string" &&
					typeof next.kind === "string" &&
					typeof next.status === "string"
				)
					setOperation((current) =>
						current &&
						current.requestId !== next.requestId &&
						(current.status === "queued" || current.status === "running")
							? current
							: (next as unknown as OperationState),
					);
				return;
			}
			if (type === "tool_approval") {
				const approvalId = typeof record.event.approvalId === "string" ? record.event.approvalId : undefined;
				const toolName = typeof record.event.toolName === "string" ? record.event.toolName : undefined;
				const argumentsValue = asRecord(record.event.arguments);
				if (approvalId)
					setApprovals((current) =>
						current.some((item) => item.approvalId === approvalId)
							? current
							: [
									...current,
									{
										approvalId,
										requestId: record.requestId,
										...(toolName ? { toolName } : {}),
										...(argumentsValue ? { arguments: argumentsValue } : {}),
										state: "pending",
									},
								],
					);
				return;
			}
			if (type === "compaction_start") {
				setCompaction({
					state: "running",
					reason: typeof record.event.reason === "string" ? record.event.reason : "threshold",
				});
				return;
			}
			if (type === "compaction_end") {
				setCompaction({
					state: record.event.success === true ? "success" : "error",
					reason: typeof record.event.reason === "string" ? record.event.reason : "threshold",
					...(typeof record.event.errorMessage === "string" ? { error: record.event.errorMessage } : {}),
				});
				void refresh().catch(() => undefined);
				return;
			}
			if (type === "tool_execution_start") {
				const id = typeof record.event.toolCallId === "string" ? record.event.toolCallId : crypto.randomUUID();
				const name = typeof record.event.toolName === "string" ? record.event.toolName : "tool";
				setTools((current) => [
					...current.filter((item) => item.id !== id),
					{ id, name, arguments: asRecord(record.event.arguments) ?? {}, status: "loading" },
				]);
				return;
			}
			if (type === "tool_execution_end") {
				const result = asRecord(record.event.result);
				const id = typeof record.event.toolCallId === "string" ? record.event.toolCallId : undefined;
				if (id) {
					const output = textFromContent(result?.content);
					const details = asRecord(result?.details);
					const isError = result?.isError === true;
					setTools((current) =>
						current.map((item) =>
							item.id === id
								? {
										...item,
										output,
										...(details ? { details } : {}),
										status: toolStatus(output, isError, details),
										...(isError ? { error: output } : {}),
									}
								: item,
						),
					);
				}
				return;
			}
			if (type === "usage_update") {
				const next = asRecord(record.event.usage);
				if (next) setUsage(next as UsageSnapshot);
				return;
			}
			if (type === "message_update") {
				const update = asRecord(record.event.event);
				if (update?.type === "text_delta" && typeof update.delta === "string") {
					const delta = update.delta;
					setMessages((current) => {
						const last = current.at(-1);
						if (last?.role === "assistant" && last.status === "streaming")
							return [...current.slice(0, -1), { ...last, text: last.text + delta }];
						return [...current, { role: "assistant", text: delta, status: "streaming" }];
					});
				}
				if (update?.type === "thinking_delta" && typeof update.delta === "string") {
					const delta = update.delta;
					setMessages((current) => {
						const last = current.at(-1);
						if (last?.role === "assistant" && last.status === "streaming")
							return [...current.slice(0, -1), { ...last, thinking: (last.thinking ?? "") + delta }];
						return [...current, { role: "assistant", text: "", thinking: delta, status: "streaming" }];
					});
				}
				return;
			}
			if (type === "message_end" || type === "agent_end") void refresh().catch(() => undefined);
		},
		[refresh],
	);

	useEffect(() => {
		if (!ready) return;
		stopped.current = false;
		void refresh().catch((cause: unknown) =>
			setError(cause instanceof Error ? cause.message : "Unable to load conversation."),
		);
		const connect = async (): Promise<void> => {
			while (!stopped.current) {
				try {
					const response = await fetch("/api/events", {
						credentials: "same-origin",
						headers: eventHeaders(sequence.current, resumeToken.current),
					});
					if (!response.ok || !response.body) throw new Error(`Event stream unavailable (${response.status}).`);
					rememberClient(response);
					setConnected(true);
					setError(undefined);
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let pending = "";
					while (!stopped.current) {
						const chunk = await reader.read();
						if (chunk.done) break;
						pending += decoder.decode(chunk.value, { stream: true });
						const frames = pending.split("\n\n");
						pending = frames.pop() ?? "";
						for (const frame of frames) {
							const data = frame
								.split("\n")
								.find((line) => line.startsWith("data: "))
								?.slice(6);
							if (!data) continue;
							const value = asRecord(JSON.parse(data));
							if (value?.resumeToken && typeof value.resumeToken === "string") resumeToken.current = value.resumeToken;
							else if (value?.kind === "event" && typeof value.requestId === "string" && asRecord(value.event))
								handleEvent(value as unknown as WireEvent);
						}
					}
					setConnected(false);
				} catch (cause) {
					setConnected(false);
					setError(cause instanceof Error ? cause.message : "Event stream disconnected.");
				}
				if (!stopped.current) await new Promise((resolve) => window.setTimeout(resolve, 800));
			}
		};
		void connect();
		return () => {
			stopped.current = true;
		};
	}, [handleEvent, ready, refresh]);

	const send = useCallback(
		async (text: string) => {
			const requestId = crypto.randomUUID();
			setError(undefined);
			setOperation({ requestId, kind: "prompt", status: "queued" });
			try {
				const result = await callRpc<{ readonly message?: { readonly stopReason?: string } }>(
					"prompt",
					{ message: text, ...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}) },
					requestId,
				);
				await refresh();
				if (result.message?.stopReason === "aborted" || result.message?.stopReason === "error") {
					setOperation({
						requestId,
						kind: "prompt",
						status: result.message.stopReason === "aborted" ? "cancelled" : "failed",
					});
				} else setOperation(undefined);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to send message.");
			} finally {
				for (const attachment of attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
				setAttachments([]);
			}
		},
		[attachments, refresh],
	);
	const steer = useCallback(
		async (text: string) => {
			try {
				await callRpc("steer", {
					message: text,
					...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}),
				});
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to steer the active response.");
			} finally {
				for (const attachment of attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
				setAttachments([]);
			}
		},
		[attachments],
	);
	const cancel = useCallback(async () => {
		if (operation?.status === "running" || operation?.status === "queued") {
			try {
				await callRpc<{ readonly cancelled: boolean }>("cancel", { requestId: operation.requestId });
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to cancel the active response.");
			}
		}
	}, [operation]);
	const compact = useCallback(async () => {
		const requestId = crypto.randomUUID();
		setError(undefined);
		setOperation({ requestId, kind: "compact", status: "queued" });
		try {
			await callRpc("compact", {}, requestId);
			await refresh();
			setOperation(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to compact the session context.");
		}
	}, [refresh]);
	const retry = useCallback(async () => {
		if (operation?.status === "failed" || operation?.status === "cancelled") {
			try {
				await callRpc("retry", { targetRequestId: operation.requestId });
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to retry the response.");
			}
		}
	}, [operation, refresh]);
	const approveTool = useCallback(async (approvalId: string, approved: boolean) => {
		try {
			await callRpc("approve_tool", { approvalId, approved }, crypto.randomUUID());
			setApprovals((current) =>
				current.map((item) =>
					item.approvalId === approvalId ? { ...item, state: approved ? "accepted" : "denied" } : item,
				),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to submit tool approval.");
		}
	}, []);
	const newSession = useCallback(async () => {
		try {
			await callRpc("new_session");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to create a new session.");
		}
	}, [refresh]);
	const openSession = useCallback(
		async (id: string) => {
			try {
				await callRpc("open_session", { sessionId: id });
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to open the selected session.");
			}
		},
		[refresh],
	);
	const addFiles = useCallback(
		async (files: FileList | readonly File[]) => {
			const selected = Array.from(files).slice(0, Math.max(0, 4 - attachments.length));
			for (const file of selected) {
				if (
					!(["image/png", "image/jpeg", "image/webp", "image/gif"] as const).includes(
						file.type as AttachmentInfo["contentType"],
					)
				)
					throw new Error("Only PNG, JPEG, WebP, and GIF images can be attached.");
				if (file.size > 5 * 1024 * 1024) throw new Error("Each attachment must be 5 MiB or smaller.");
				const encoded = await dataUrlFor(file);
				try {
					const info = await uploadAttachment({
						name: file.name,
						contentType: file.type as AttachmentInfo["contentType"],
						data: encoded,
					});
					setAttachments((current) => [...current, { ...info, previewUrl: URL.createObjectURL(file) }]);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : "Unable to upload attachment.");
				}
			}
		},
		[attachments.length],
	);

	return {
		sessions,
		activeSessionId,
		messages,
		tools,
		approvals,
		contextFiles,
		compaction,
		usage,
		operation,
		attachments,
		connected,
		error,
		send,
		steer,
		cancel,
		compact,
		retry,
		newSession,
		openSession,
		addFiles,
		removeAttachment: (id) =>
			setAttachments((current) => {
				const attachment = current.find((item) => item.id === id);
				if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
				return current.filter((item) => item.id !== id);
			}),
		approveTool,
	};
}
