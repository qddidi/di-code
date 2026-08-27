import { useCallback, useEffect, useRef, useState } from "react";
import {
	branchSession,
	callRpc,
	deleteSession,
	eventHeaders,
	eventsPath,
	inspectSession,
	loadSessions,
	rememberClient,
	renameSession,
	uploadAttachment,
} from "./api.ts";
import type {
	AttachmentInfo,
	CommandAction,
	CommandSummary,
	ContextFile,
	ConversationActivity,
	ConversationImage,
	ConversationMessage,
	OperationState,
	SessionSummary,
	SessionTreeNode,
	ToolApproval,
	ToolTrace,
	TreeNavigation,
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
	readonly commands: readonly CommandSummary[];
	readonly tree: readonly SessionTreeNode[];
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
	readonly runCommand: (name: string, args: string) => Promise<CommandAction | undefined>;
	readonly navigateTree: (entryId: string) => Promise<TreeNavigation | undefined>;
	readonly clearVisibleMessages: () => void;
	readonly retry: () => Promise<void>;
	readonly newSession: () => Promise<void>;
	readonly openSession: (id: string) => Promise<void>;
	readonly renameSession: (id: string, label: string) => Promise<void>;
	readonly deleteSession: (id: string) => Promise<void>;
	readonly branchSession: (id: string, entryId?: string) => Promise<void>;
	readonly inspectSession: (id: string) => Promise<unknown>;
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

function expandedSkillName(text: string): string | undefined {
	return /^<explicit_skill name="([a-z0-9]+(?:-[a-z0-9]+)*)" path="[^"]+">/.exec(text)?.[1];
}

function imagesFromContent(content: unknown): readonly ConversationImage[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		const block = asRecord(item);
		if (block?.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return [];
		return [{ src: `data:${block.mimeType};base64,${block.data}`, mimeType: block.mimeType, alt: "Attached image" }];
	});
}

function toolStatus(output: string, isError: boolean, details?: Record<string, unknown>): ToolTrace["status"] {
	if (details?.truncated === true) return "truncated";
	if (!isError) return "success";
	const normalized = output.toLowerCase();
	if (normalized.includes("timed out")) return "timeout";
	if (normalized.includes("aborted") || normalized.includes("cancelled")) return "cancelled";
	return "error";
}

function appendThinking(activities: readonly ConversationActivity[], delta: string): readonly ConversationActivity[] {
	const last = activities.at(-1);
	if (last?.kind === "thinking") return [...activities.slice(0, -1), { ...last, text: last.text + delta }];
	return [...activities, { id: `thinking-${activities.length}`, kind: "thinking", text: delta }];
}

function updateActivityTool(
	activities: readonly ConversationActivity[],
	id: string,
	tool: ToolTrace,
): readonly ConversationActivity[] {
	const found = activities.some((activity) => activity.kind === "tool" && activity.tool.id === id);
	return found
		? activities.map((activity) =>
				activity.kind === "tool" && activity.tool.id === id ? { ...activity, tool } : activity,
			)
		: [...activities, { id, kind: "tool", tool }];
}

function messagesFromTranscript(
	transcript: unknown,
	entryIds: readonly unknown[] = [],
): { messages: ConversationMessage[]; tools: ToolTrace[] } {
	if (!Array.isArray(transcript)) return { messages: [], tools: [] };
	const tools: ToolTrace[] = [];
	const messages: ConversationMessage[] = [];
	let assistant: { text: string; activities: readonly ConversationActivity[]; entryId?: string } | undefined;
	const flushAssistant = (): void => {
		if (!assistant) return;
		messages.push({
			role: "assistant",
			text: assistant.text,
			...(assistant.activities.length ? { activities: assistant.activities } : {}),
			...(assistant.entryId ? { entryId: assistant.entryId } : {}),
		});
		assistant = undefined;
	};
	const ensureAssistant = (): NonNullable<typeof assistant> => {
		if (!assistant) assistant = { text: "", activities: [] };
		return assistant;
	};
	for (const [index, value] of transcript.entries()) {
		const message = asRecord(value);
		const entryId = typeof entryIds[index] === "string" ? entryIds[index] : undefined;
		if (!message || (message.role !== "user" && message.role !== "assistant" && message.role !== "tool_result"))
			continue;
		if (message.role === "user") {
			flushAssistant();
			const images = imagesFromContent(message.content);
			const text = textFromContent(message.content);
			const skillName = expandedSkillName(text);
			messages.push({
				role: "user",
				text: skillName ? "" : text,
				...(skillName ? { skillName } : {}),
				...(images.length ? { images } : {}),
				...(entryId ? { entryId } : {}),
			});
			continue;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error") {
				flushAssistant();
				messages.push({
					role: "assistant",
					text:
						typeof message.errorMessage === "string" && message.errorMessage.trim()
							? message.errorMessage
							: "The model request failed.",
					status: "error",
					...(entryId ? { entryId } : {}),
				});
				continue;
			}
			if (message.stopReason === "aborted") {
				flushAssistant();
				continue;
			}
			if (!Array.isArray(message.content)) continue;
			for (const item of message.content) {
				const current = ensureAssistant();
				const block = asRecord(item);
				if (block?.type === "text" && typeof block.text === "string")
					assistant = { ...current, text: current.text + block.text, ...(entryId ? { entryId } : {}) };
				if (block?.type === "thinking" && typeof block.thinking === "string")
					assistant = {
						...current,
						activities: appendThinking(current.activities, block.thinking),
						...(entryId ? { entryId } : {}),
					};
				if (block?.type === "tool_call" && typeof block.id === "string" && typeof block.name === "string") {
					const tool = {
						id: block.id,
						name: block.name,
						arguments: asRecord(block.arguments) ?? {},
						status: "loading",
					} as ToolTrace;
					const previous = tools.findIndex((item) => item.id === tool.id);
					if (previous === -1) tools.push(tool);
					else tools[previous] = tool;
					assistant = {
						...current,
						activities: updateActivityTool(current.activities, tool.id, tool),
						...(entryId ? { entryId } : {}),
					};
				}
			}
			continue;
		}
		const id = typeof message.toolCallId === "string" ? message.toolCallId : crypto.randomUUID();
		const output = textFromContent(message.content);
		const details = asRecord(message.details);
		const previous = tools.find((item) => item.id === id);
		const tool = {
			id,
			name: typeof message.toolName === "string" ? message.toolName : (previous?.name ?? "tool"),
			arguments: previous?.arguments ?? {},
			output,
			...(details ? { details } : {}),
			status: toolStatus(output, message.isError === true, details),
			...(message.isError === true ? { error: output } : {}),
		} as ToolTrace;
		const previousIndex = tools.findIndex((item) => item.id === id);
		if (previousIndex === -1) tools.push(tool);
		else tools[previousIndex] = tool;
		const current = ensureAssistant();
		assistant = {
			...current,
			activities: updateActivityTool(current.activities, id, tool),
			...(entryId ? { entryId } : {}),
		};
	}
	flushAssistant();
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
	const entryIds: unknown[] = [];
	let pageToken: string | undefined;
	do {
		const result = await callRpc<{
			readonly transcript: unknown[];
			readonly entryIds?: readonly unknown[];
			readonly nextPageToken?: string;
		}>("get_transcript", {
			pageSize: 200,
			maxBytes: 8 * 1024 * 1024,
			...(pageToken ? { pageToken } : {}),
		});
		transcript.push(...result.transcript);
		entryIds.push(...(result.entryIds ?? []));
		pageToken = result.nextPageToken;
	} while (pageToken);
	return messagesFromTranscript(transcript, entryIds);
}

export function useConversation(ready: boolean, workspaceId: string | undefined): ConversationState {
	const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string>();
	const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
	const [tools, setTools] = useState<readonly ToolTrace[]>([]);
	const [approvals, setApprovals] = useState<readonly ToolApproval[]>([]);
	const [contextFiles, setContextFiles] = useState<readonly ContextFile[]>([]);
	const [commands, setCommands] = useState<readonly CommandSummary[]>([]);
	const [tree, setTree] = useState<readonly SessionTreeNode[]>([]);
	const [compaction, setCompaction] = useState<ConversationState["compaction"]>();
	const [usage, setUsage] = useState<UsageSnapshot>();
	const [operation, setOperation] = useState<OperationState>();
	const [attachments, setAttachments] = useState<readonly AttachmentInfo[]>([]);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string>();
	const pendingSessions = useRef<readonly SessionSummary[]>([]);
	const lastCompactionError = useRef<string | undefined>(undefined);
	const sequence = useRef(0);
	const resumeToken = useRef<string | undefined>(undefined);
	const stopped = useRef(false);
	const workspaceRef = useRef(workspaceId);
	const refreshState = useRef<
		| {
				workspaceId: string | undefined;
				queued: boolean;
				promise?: Promise<void>;
		  }
		| undefined
	>(undefined);
	const refreshTimer = useRef<number | undefined>(undefined);
	useEffect(() => {
		workspaceRef.current = workspaceId;
		// Never let a snapshot for the previous actor satisfy refreshes for the
		// newly selected workspace. The workspace-row plus switches actors first.
		refreshState.current = undefined;
		sequence.current = 0;
		resumeToken.current = undefined;
		if (refreshTimer.current !== undefined) {
			window.clearTimeout(refreshTimer.current);
			refreshTimer.current = undefined;
		}
		setSessions([]);
		pendingSessions.current = [];
		setActiveSessionId(undefined);
		setMessages([]);
		setTools([]);
		setApprovals([]);
		setContextFiles([]);
		setCommands([]);
		setTree([]);
		setCompaction(undefined);
		setUsage(undefined);
		setOperation(undefined);
		setAttachments((current) => {
			for (const attachment of current) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
			return [];
		});
	}, [workspaceId]);

	const performRefresh = useCallback(async () => {
		const requestedWorkspace = workspaceId;
		if (workspaceRef.current !== requestedWorkspace) return;
		// The first request establishes the actor identity before the parallel snapshot reads begin.
		const stateResult = await callRpc<{ readonly state: { readonly sessionId: string; readonly sequence?: number } }>(
			"get_state",
		);
		const [sessionResult, transcript, usageResult, contextResult, commandResult, treeResult] = await Promise.all([
			loadSessions(),
			readAllPages(),
			callRpc<{ readonly usage: UsageSnapshot }>("get_usage"),
			callRpc<{ readonly files: readonly ContextFile[] }>("list_context_files").catch(() => ({ files: [] })),
			callRpc<{ readonly commands: readonly CommandSummary[] }>("list_commands").catch(() => ({ commands: [] })),
			callRpc<{ readonly tree: readonly SessionTreeNode[] }>("get_tree").catch(() => ({ tree: [] })),
		]);
		if (workspaceRef.current !== requestedWorkspace) return;
		const serverSessionIds = new Set(sessionResult.sessions.map((session) => session.id));
		const pending = pendingSessions.current.filter((item) => !serverSessionIds.has(item.id));
		pendingSessions.current = pending;
		setSessions([...pending, ...sessionResult.sessions]);
		setActiveSessionId(stateResult.state.sessionId === "uninitialized" ? undefined : stateResult.state.sessionId);
		sequence.current = Math.max(sequence.current, stateResult.state.sequence ?? 0);
		setMessages(transcript.messages);
		setTools(transcript.tools);
		setContextFiles(contextResult.files);
		setCommands(commandResult.commands);
		setTree(treeResult.tree);
		setUsage(usageResult.usage);
	}, [workspaceId]);

	// Snapshot reads are relatively expensive. Coalesce concurrent callers and allow
	// at most one follow-up refresh for events received while a read is in flight.
	const refresh = useCallback((): Promise<void> => {
		if (refreshTimer.current !== undefined) {
			window.clearTimeout(refreshTimer.current);
			refreshTimer.current = undefined;
		}
		const requestedWorkspace = workspaceId;
		const existing = refreshState.current;
		if (existing && existing.workspaceId === requestedWorkspace && existing.promise) {
			existing.queued = true;
			return existing.promise;
		}
		const state: {
			workspaceId: string | undefined;
			queued: boolean;
			promise?: Promise<void>;
		} = { workspaceId: requestedWorkspace, queued: false };
		const run = async (): Promise<void> => {
			while (true) {
				state.queued = false;
				await performRefresh();
				if (!state.queued) return;
			}
		};
		const promise = run();
		state.promise = promise;
		refreshState.current = state;
		const clearInFlight = (): void => {
			if (refreshState.current === state) refreshState.current = undefined;
		};
		void promise.then(clearInFlight, clearInFlight);
		return promise;
	}, [performRefresh, workspaceId]);

	const scheduleRefresh = useCallback((): void => {
		if (refreshTimer.current !== undefined) return;
		refreshTimer.current = window.setTimeout(() => {
			refreshTimer.current = undefined;
			void refresh().catch((cause: unknown) =>
				setError(cause instanceof Error ? cause.message : "Unable to restore conversation."),
			);
		}, 75);
	}, [refresh]);

	const handleEvent = useCallback(
		(record: WireEvent) => {
			if (record.sequence !== undefined) {
				if (record.sequence <= sequence.current) return;
				sequence.current = record.sequence;
			}
			const type = record.event.type;
			if (type === "snapshot_required" || type === "session_changed") {
				scheduleRefresh();
				return;
			}
			if (type === "operation_update") {
				const next = asRecord(record.event.operation);
				if (
					next &&
					typeof next.requestId === "string" &&
					typeof next.kind === "string" &&
					typeof next.status === "string"
				) {
					if (next.kind !== "prompt" && next.kind !== "steer" && next.kind !== "retry" && next.kind !== "compact")
						return;
					setOperation((current) =>
						current &&
						current.requestId !== next.requestId &&
						(current.status === "queued" || current.status === "running")
							? current
							: (next as unknown as OperationState),
					);
				}
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
				lastCompactionError.current = undefined;
				setCompaction({
					state: "running",
					reason: typeof record.event.reason === "string" ? record.event.reason : "threshold",
				});
				return;
			}
			if (type === "compaction_end") {
				lastCompactionError.current =
					record.event.success === true || typeof record.event.errorMessage !== "string"
						? undefined
						: record.event.errorMessage;
				setCompaction({
					state: record.event.success === true ? "success" : "error",
					reason: typeof record.event.reason === "string" ? record.event.reason : "threshold",
					...(typeof record.event.errorMessage === "string" ? { error: record.event.errorMessage } : {}),
				});
				scheduleRefresh();
				return;
			}
			if (type === "tool_execution_start") {
				const id = typeof record.event.toolCallId === "string" ? record.event.toolCallId : crypto.randomUUID();
				const name = typeof record.event.toolName === "string" ? record.event.toolName : "tool";
				const tool = { id, name, arguments: asRecord(record.event.arguments) ?? {}, status: "loading" } as ToolTrace;
				setTools((current) => [...current.filter((item) => item.id !== id), tool]);
				setMessages((current) => {
					const last = current.at(-1);
					if (last?.role === "assistant" && last.status === "streaming")
						return [
							...current.slice(0, -1),
							{ ...last, activities: updateActivityTool(last.activities ?? [], id, tool) },
						];
					return [
						...current,
						{ role: "assistant", text: "", activities: [{ id, kind: "tool", tool }], status: "streaming" },
					];
				});
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
					setMessages((current) =>
						current.map((message) => {
							if (message.role !== "assistant" || !message.activities) return message;
							const activity = message.activities.find((item) => item.kind === "tool" && item.tool.id === id);
							if (!activity || activity.kind !== "tool") return message;
							const completedTool: ToolTrace = {
								...activity.tool,
								output,
								...(details ? { details } : {}),
								status: toolStatus(output, isError, details),
								...(isError ? { error: output } : {}),
							};
							return { ...message, activities: updateActivityTool(message.activities, id, completedTool) };
						}),
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
							return [
								...current.slice(0, -1),
								{
									...last,
									thinking: (last.thinking ?? "") + delta,
									activities: appendThinking(last.activities ?? [], delta),
								},
							];
						return [
							...current,
							{
								role: "assistant",
								text: "",
								thinking: delta,
								activities: appendThinking([], delta),
								status: "streaming",
							},
						];
					});
				}
				return;
			}
			if (type === "agent_end") scheduleRefresh();
		},
		[scheduleRefresh],
	);

	useEffect(() => {
		if (!ready || !workspaceId) return;
		stopped.current = false;
		void refresh().catch((cause: unknown) =>
			setError(cause instanceof Error ? cause.message : "Unable to load conversation."),
		);
		const connect = async (): Promise<void> => {
			while (!stopped.current) {
				try {
					const response = await fetch(eventsPath(), {
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
			if (refreshTimer.current !== undefined) {
				window.clearTimeout(refreshTimer.current);
				refreshTimer.current = undefined;
			}
		};
	}, [handleEvent, ready, refresh, workspaceId]);

	const send = useCallback(
		async (text: string) => {
			const requestId = crypto.randomUUID();
			setError(undefined);
			setOperation({ requestId, kind: "prompt", status: "queued" });
			setMessages((current) => [
				...current,
				{
					role: "user",
					text,
					...(attachments.length
						? {
								images: attachments.flatMap((attachment) =>
									attachment.previewUrl
										? [
												{
													src: attachment.previewUrl,
													mimeType: attachment.contentType,
													alt: attachment.name,
												},
											]
										: [],
								),
							}
						: {}),
				},
			]);
			try {
				const result = await callRpc<{
					readonly message?: { readonly stopReason?: string; readonly errorMessage?: string };
				}>(
					"prompt",
					{ message: text, ...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}) },
					requestId,
				);
				await refresh();
				if (result.message?.stopReason === "aborted" || result.message?.stopReason === "error") {
					const failed = result.message.stopReason === "error";
					setOperation({
						requestId,
						kind: "prompt",
						status: failed ? "failed" : "cancelled",
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
		lastCompactionError.current = undefined;
		setCompaction({ state: "running", reason: "manual" });
		setOperation({ requestId, kind: "compact", status: "queued" });
		try {
			await callRpc("compact", {}, requestId);
			await refresh();
			setOperation(undefined);
		} catch (cause) {
			const message =
				lastCompactionError.current ??
				(cause instanceof Error ? cause.message : "Unable to compact the session context.");
			setCompaction({ state: "error", reason: "manual", error: message });
			setOperation({ requestId, kind: "compact", status: "failed", error: { code: "INTERNAL_ERROR", message } });
		}
	}, [refresh]);
	const runCommand = useCallback(async (name: string, args: string): Promise<CommandAction | undefined> => {
		try {
			const result = await callRpc<{ readonly action?: CommandAction }>("run_command", { name, args });
			return result.action;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to run the command.");
			return undefined;
		}
	}, []);
	const navigateTree = useCallback(
		async (entryId: string): Promise<TreeNavigation | undefined> => {
			try {
				const result = await callRpc<{ readonly navigation: TreeNavigation }>("navigate_tree", { entryId });
				await refresh();
				return result.navigation;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to navigate the session tree.");
				return undefined;
			}
		},
		[refresh],
	);
	const clearVisibleMessages = useCallback(() => {
		setMessages([]);
		setTools([]);
	}, []);
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
		const placeholderId = `pending-${crypto.randomUUID()}`;
		const placeholder: SessionSummary = {
			id: placeholderId,
			label: "New session",
			modifiedAt: new Date().toISOString(),
		};
		pendingSessions.current = [placeholder, ...pendingSessions.current];
		setSessions((current) => [placeholder, ...current]);
		setActiveSessionId(placeholderId);
		try {
			const result = await callRpc<{ readonly session: SessionSummary }>("new_session");
			pendingSessions.current = [result.session];
			setSessions((current) => [result.session, ...current.filter((session) => session.id !== placeholderId)]);
			await refresh();
			pendingSessions.current = pendingSessions.current.filter((session) => session.id !== result.session.id);
			setActiveSessionId(result.session.id);
		} catch (cause) {
			pendingSessions.current = pendingSessions.current.filter((session) => session.id !== placeholderId);
			setSessions((current) => current.filter((session) => session.id !== placeholderId));
			setActiveSessionId(undefined);
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
	const rename = useCallback(
		async (id: string, label: string) => {
			try {
				await renameSession(id, label);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to rename the session.");
			}
		},
		[refresh],
	);
	const remove = useCallback(
		async (id: string) => {
			try {
				await deleteSession(id);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to delete the session.");
			}
		},
		[refresh],
	);
	const branch = useCallback(
		async (id: string, entryId?: string) => {
			try {
				const session = await branchSession(id, entryId);
				setActiveSessionId(session.id);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to branch the session.");
			}
		},
		[refresh],
	);
	const inspect = useCallback(async (id: string) => await inspectSession(id), []);
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
		commands,
		tree,
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
		runCommand,
		navigateTree,
		clearVisibleMessages,
		retry,
		newSession,
		openSession,
		renameSession: rename,
		deleteSession: remove,
		branchSession: branch,
		inspectSession: inspect,
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
