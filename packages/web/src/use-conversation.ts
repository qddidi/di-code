import { useCallback, useEffect, useRef, useState } from "react";
import {
	branchSession,
	deleteSession,
	eventHeaders,
	eventsPath,
	inspectSession,
	loadSessionSnapshot,
	callRpc as rawCallRpc,
	rememberClient,
	renameSession,
	respondInteraction as sendInteractionResponse,
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
	SessionSnapshot,
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
	readonly sessionId?: string;
	readonly runId?: string;
	readonly event: Record<string, unknown>;
}

export interface ConversationState {
	readonly sessions: readonly SessionSummary[];
	readonly activeSessionId?: string;
	readonly runningSessionIds: ReadonlySet<string>;
	readonly sessionChanging: boolean;
	readonly messages: readonly ConversationMessage[];
	readonly tools: readonly ToolTrace[];
	readonly approvals: readonly ToolApproval[];
	readonly interactions: readonly {
		readonly requestId: string;
		readonly kind: string;
		readonly prompt: string;
		readonly intent?: string;
		readonly options?: readonly { readonly value: string; readonly label: string }[];
	}[];
	readonly projections: Readonly<Record<string, { readonly version: number; readonly state: unknown }>>;
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
	readonly queuedPrompts: readonly string[];
	readonly steeringPrompts: readonly string[];
	readonly attachments: readonly AttachmentInfo[];
	readonly connected: boolean;
	readonly error?: string;
	readonly errorRevision: number;
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
	readonly respondInteraction: (
		requestId: string,
		result: {
			readonly status: "answered" | "cancelled" | "timeout";
			readonly value?: string;
			readonly approved?: boolean;
			readonly feedback?: string;
		},
	) => Promise<void>;
}

interface PromptQueueItem {
	readonly text: string;
	readonly attachments: readonly AttachmentInfo[];
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
		const padding = block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0;
		const decodedBytes = Math.floor((block.data.length * 3) / 4) - padding;
		if (
			!/^image\/[A-Za-z0-9.+-]+$/.test(block.mimeType) ||
			block.data.length === 0 ||
			block.data.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(block.data) ||
			decodedBytes <= 0 ||
			decodedBytes > 5 * 1024 * 1024
		)
			return [];
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
	let assistant:
		| {
				text: string;
				activities: readonly ConversationActivity[];
				images: readonly ConversationImage[];
				entryId?: string;
		  }
		| undefined;
	const flushAssistant = (): void => {
		if (!assistant) return;
		messages.push({
			role: "assistant",
			text: assistant.text,
			...(assistant.activities.length ? { activities: assistant.activities } : {}),
			...(assistant.images.length ? { images: assistant.images } : {}),
			...(assistant.entryId ? { entryId: assistant.entryId } : {}),
		});
		assistant = undefined;
	};
	const ensureAssistant = (): NonNullable<typeof assistant> => {
		if (!assistant) assistant = { text: "", activities: [], images: [] };
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
				if (block?.type === "image") {
					const images = imagesFromContent([block]);
					if (images.length > 0)
						assistant = { ...current, images: [...current.images, ...images], ...(entryId ? { entryId } : {}) };
				}
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
		const images = imagesFromContent(message.content);
		const details = asRecord(message.details);
		const previous = tools.find((item) => item.id === id);
		const tool = {
			id,
			name: typeof message.toolName === "string" ? message.toolName : (previous?.name ?? "tool"),
			arguments: previous?.arguments ?? {},
			output,
			...(images.length ? { images } : {}),
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
			...(images.length ? { images: [...current.images, ...images] } : {}),
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

async function readAllPages(
	sessionId: string,
	workspaceId: string | undefined,
	initial?: Pick<SessionSnapshot, "transcript" | "entryIds" | "nextPageToken">,
): Promise<{ messages: ConversationMessage[]; tools: ToolTrace[] }> {
	const transcript: unknown[] = [...(initial?.transcript ?? [])];
	const entryIds: unknown[] = [...(initial?.entryIds ?? [])];
	let pageToken: string | undefined = initial?.nextPageToken;
	if (!initial) pageToken = undefined;
	let firstPage = initial === undefined;
	do {
		if (!firstPage && pageToken === undefined) break;
		const result = await rawCallRpc<{
			readonly transcript: unknown[];
			readonly entryIds?: readonly unknown[];
			readonly nextPageToken?: string;
		}>(
			"get_transcript",
			{
				sessionId,
				pageSize: 200,
				maxBytes: 8 * 1024 * 1024,
				...(pageToken ? { pageToken } : {}),
			},
			crypto.randomUUID(),
			workspaceId,
		);
		transcript.push(...result.transcript);
		entryIds.push(...(result.entryIds ?? []));
		pageToken = result.nextPageToken;
		firstPage = false;
	} while (pageToken);
	return messagesFromTranscript(transcript, entryIds);
}

export function useConversation(ready: boolean, workspaceId: string | undefined): ConversationState {
	const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string>();
	const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(new Set());
	const [sessionChanging, setSessionChanging] = useState(false);
	const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
	const [tools, setTools] = useState<readonly ToolTrace[]>([]);
	const [approvals, setApprovals] = useState<readonly ToolApproval[]>([]);
	const [interactions, setInteractions] = useState<ConversationState["interactions"]>([]);
	const [projections, setProjections] = useState<ConversationState["projections"]>({});
	const [contextFiles, setContextFiles] = useState<readonly ContextFile[]>([]);
	const [commands, setCommands] = useState<readonly CommandSummary[]>([]);
	const [tree, setTree] = useState<readonly SessionTreeNode[]>([]);
	const [compaction, setCompaction] = useState<ConversationState["compaction"]>();
	const [usage, setUsage] = useState<UsageSnapshot>();
	const [operation, setOperation] = useState<OperationState>();
	const [queuedPrompts, setQueuedPrompts] = useState<readonly string[]>([]);
	const [steeringPrompts, setSteeringPrompts] = useState<readonly string[]>([]);
	const [attachments, setAttachments] = useState<readonly AttachmentInfo[]>([]);
	const [connected, setConnected] = useState(false);
	const [error, setErrorState] = useState<string>();
	const [errorRevision, setErrorRevision] = useState(0);
	const setError = useCallback((message?: string): void => {
		setErrorState(message);
		if (message) setErrorRevision((current) => current + 1);
	}, []);
	const pendingSessions = useRef<readonly SessionSummary[]>([]);
	const pendingDeletedSessions = useRef<ReadonlySet<string>>(new Set());
	const lastCompactionError = useRef<string | undefined>(undefined);
	const sequence = useRef(0);
	const resumeToken = useRef<string | undefined>(undefined);
	const workspaceRef = useRef(workspaceId);
	const activeSessionRef = useRef<string | undefined>(undefined);
	const sessionGeneration = useRef(0);
	const openingSessionKey = useRef<string | undefined>(undefined);
	const promptQueue = useRef<PromptQueueItem[]>([]);
	const promptRunning = useRef(false);
	const steeringPromptsRef = useRef<string[]>([]);
	const callRpc = useCallback(
		<T>(method: string, params: Record<string, unknown> = {}, requestId?: string): Promise<T> =>
			rawCallRpc<T>(method, params, requestId ?? crypto.randomUUID(), workspaceId),
		[workspaceId],
	);
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
		sessionGeneration.current += 1;
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
		openingSessionKey.current = undefined;
		pendingDeletedSessions.current = new Set();
		setActiveSessionId(undefined);
		setRunningSessionIds(new Set());
		setSessionChanging(false);
		setMessages([]);
		setTools([]);
		setApprovals([]);
		setInteractions([]);
		setProjections({});
		setContextFiles([]);
		setCommands([]);
		setTree([]);
		setCompaction(undefined);
		setUsage(undefined);
		setOperation(undefined);
		promptQueue.current = [];
		setQueuedPrompts([]);
		setSteeringPrompts([]);
		steeringPromptsRef.current = [];
		setError(undefined);
		setAttachments((current) => {
			for (const attachment of current) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
			return [];
		});
	}, [workspaceId, setError]);
	useEffect(() => {
		activeSessionRef.current = activeSessionId;
	}, [activeSessionId]);

	const performRefresh = useCallback(async () => {
		const requestedWorkspace = workspaceId;
		const requestedGeneration = sessionGeneration.current;
		if (workspaceRef.current !== requestedWorkspace) return;
		const snapshot = await loadSessionSnapshot(requestedWorkspace);
		const sessionId = snapshot.state.sessionId;
		if (!sessionId || sessionId === "uninitialized") throw new Error("No session is available.");
		const transcript = await readAllPages(sessionId, requestedWorkspace, snapshot);
		if (workspaceRef.current !== requestedWorkspace || sessionGeneration.current !== requestedGeneration) return;
		const visibleServerSessions = snapshot.sessions.filter(
			(session) => !pendingDeletedSessions.current.has(session.id),
		);
		const serverSessionIds = new Set(visibleServerSessions.map((session) => session.id));
		const pending = pendingSessions.current.filter((item) => !serverSessionIds.has(item.id));
		pendingSessions.current = pending;
		setSessions([...pending, ...visibleServerSessions]);
		setActiveSessionId(
			snapshot.state.sessionId === "uninitialized" || pendingDeletedSessions.current.has(snapshot.state.sessionId)
				? undefined
				: snapshot.state.sessionId,
		);
		setMessages(transcript.messages);
		setTools(transcript.tools);
		sequence.current = Math.max(sequence.current, snapshot.state.sequence ?? 0);
		setUsage(snapshot.usage);
		setContextFiles(snapshot.contextFiles);
		setCommands(snapshot.commands);
		setTree(snapshot.tree);
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
	}, [refresh, setError]);

	const handleEvent = useCallback(
		(record: WireEvent) => {
			const type = record.event.type;
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
					const sessionId = record.sessionId ?? (typeof next.sessionId === "string" ? next.sessionId : undefined);
					if (sessionId) {
						setRunningSessionIds((current) => {
							const running = next.status === "queued" || next.status === "running";
							if (running === current.has(sessionId)) return current;
							const updated = new Set(current);
							if (running) updated.add(sessionId);
							else updated.delete(sessionId);
							return updated;
						});
					}
				}
			}
			// These events describe actor-wide state. A session_changed event carries
			// the newly selected session id, so it must be handled before filtering
			// events against the currently rendered session.
			if (type === "snapshot_required" || type === "session_changed") {
				scheduleRefresh();
				return;
			}
			if (type === "queue_update") {
				if (Array.isArray(record.event.steering) && record.event.steering.every((item) => typeof item === "string")) {
					steeringPromptsRef.current = record.event.steering as string[];
					setSteeringPrompts(steeringPromptsRef.current);
				}
				return;
			}
			// Render stream payloads only for the selected session; background runs remain server-owned
			// and are picked up through the next session snapshot.
			if (record.sessionId !== undefined && record.sessionId !== activeSessionRef.current) return;
			if (record.sequence !== undefined) {
				if (record.sequence <= sequence.current) return;
				sequence.current = record.sequence;
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
			if (type === "interaction_request") {
				const requestId =
					typeof record.event.interactionRequestId === "string" ? record.event.interactionRequestId : undefined;
				const prompt = typeof record.event.prompt === "string" ? record.event.prompt : undefined;
				if (!requestId || !prompt) return;
				setInteractions((current) =>
					current.some((item) => item.requestId === requestId)
						? current
						: [
								...current,
								{
									requestId,
									kind: typeof record.event.kind === "string" ? record.event.kind : "question",
									prompt,
									...(typeof record.event.intent === "string" ? { intent: record.event.intent } : {}),
									...(Array.isArray(record.event.options)
										? {
												options: record.event.options.filter(
													(item): item is { value: string; label: string } =>
														asRecord(item)?.value !== undefined &&
														typeof asRecord(item)?.value === "string" &&
														typeof asRecord(item)?.label === "string",
												),
											}
										: {}),
								},
							],
				);
				return;
			}
			if (type === "projection") {
				const namespace = typeof record.event.namespace === "string" ? record.event.namespace : undefined;
				const projectionName =
					typeof record.event.projectionName === "string" ? record.event.projectionName : undefined;
				const version =
					typeof record.event.version === "number" && Number.isSafeInteger(record.event.version)
						? record.event.version
						: undefined;
				if (namespace && projectionName && version !== undefined && "state" in record.event)
					setProjections((current) => ({
						...current,
						[`${namespace}:${projectionName}`]: { version, state: structuredClone(record.event.state) },
					}));
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
					const images = imagesFromContent(result?.content);
					const details = asRecord(result?.details);
					const isError = result?.isError === true;
					setTools((current) =>
						current.map((item) =>
							item.id === id
								? {
										...item,
										output,
										...(images.length ? { images } : {}),
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
								...(images.length ? { images } : {}),
								...(details ? { details } : {}),
								status: toolStatus(output, isError, details),
								...(isError ? { error: output } : {}),
							};
							return {
								...message,
								activities: updateActivityTool(message.activities, id, completedTool),
								...(images.length ? { images: [...(message.images ?? []), ...images] } : {}),
							};
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
				if (update?.type === "image") {
					const images = imagesFromContent([update.image]);
					if (images.length > 0)
						setMessages((current) => {
							const last = current.at(-1);
							if (last?.role === "assistant" && last.status === "streaming")
								return [...current.slice(0, -1), { ...last, images: [...(last.images ?? []), ...images] }];
							return [...current, { role: "assistant", text: "", images, status: "streaming" }];
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
		let stopped = false;
		const connectionController = new AbortController();
		const startTimer = window.setTimeout(() => {
			void refresh().catch((cause: unknown) =>
				setError(cause instanceof Error ? cause.message : "Unable to load conversation."),
			);
			void connect();
		}, 100);
		const connect = async (): Promise<void> => {
			let reconnectDelay = 800;
			while (!stopped && !connectionController.signal.aborted) {
				try {
					const response = await fetch(eventsPath(workspaceId), {
						credentials: "same-origin",
						headers: eventHeaders(sequence.current, resumeToken.current),
						signal: connectionController.signal,
					});
					if (!response.ok || !response.body) throw new Error(`Event stream unavailable (${response.status}).`);
					reconnectDelay = 800;
					rememberClient(response);
					setConnected(true);
					setError(undefined);
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let pending = "";
					while (!stopped && !connectionController.signal.aborted) {
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
					if (!stopped && !connectionController.signal.aborted) setConnected(false);
				} catch (cause) {
					if (connectionController.signal.aborted || stopped) break;
					setConnected(false);
					setError(cause instanceof Error ? cause.message : "Event stream disconnected.");
				}
				if (!stopped && !connectionController.signal.aborted)
					await new Promise((resolve) => window.setTimeout(resolve, reconnectDelay));
				reconnectDelay = Math.min(5_000, reconnectDelay * 2);
			}
		};
		return () => {
			stopped = true;
			window.clearTimeout(startTimer);
			connectionController.abort();
			if (refreshTimer.current !== undefined) {
				window.clearTimeout(refreshTimer.current);
				refreshTimer.current = undefined;
			}
		};
	}, [handleEvent, ready, refresh, setError, workspaceId]);

	const runPrompt = useCallback(
		async (item: PromptQueueItem): Promise<void> => {
			const requestedWorkspace = workspaceId;
			if (!activeSessionId || sessionChanging) {
				setError("Wait for the session to finish opening before sending a message.");
				return;
			}
			const requestId = crypto.randomUUID();
			setError(undefined);
			setOperation({ requestId, kind: "prompt", status: "queued" });
			setRunningSessionIds((current) => new Set(current).add(activeSessionId));
			setMessages((current) => [
				...current,
				{
					role: "user",
					text: item.text,
					...(item.attachments.length
						? {
								images: item.attachments.flatMap((attachment) =>
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
					{
						sessionId: activeSessionId,
						message: item.text,
						...(item.attachments.length ? { attachmentIds: item.attachments.map((attachment) => attachment.id) } : {}),
					},
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
				if (workspaceRef.current !== requestedWorkspace) return;
				setError(cause instanceof Error ? cause.message : "Unable to send message.");
			} finally {
				for (const attachment of item.attachments)
					if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
				if (workspaceRef.current === requestedWorkspace)
					setRunningSessionIds((current) => {
						const next = new Set(current);
						next.delete(activeSessionId);
						return next;
					});
			}
		},
		[refresh, activeSessionId, sessionChanging, setError, callRpc, workspaceId],
	);
	const drainPromptQueue = useCallback(async (): Promise<void> => {
		if (promptRunning.current) return;
		const next = promptQueue.current.shift();
		setQueuedPrompts(promptQueue.current.map((item) => item.text));
		if (!next) return;
		promptRunning.current = true;
		try {
			await runPrompt(next);
		} finally {
			promptRunning.current = false;
			if (promptQueue.current.length) void drainPromptQueue();
		}
	}, [runPrompt]);
	const send = useCallback(
		async (text: string): Promise<void> => {
			const item: PromptQueueItem = { text, attachments: [...attachments] };
			setAttachments([]);
			if (promptRunning.current || operation?.status === "queued" || operation?.status === "running") {
				promptQueue.current.push(item);
				setQueuedPrompts(promptQueue.current.map((queued) => queued.text));
				return;
			}
			promptRunning.current = true;
			try {
				await runPrompt(item);
			} finally {
				promptRunning.current = false;
				if (promptQueue.current.length) void drainPromptQueue();
			}
		},
		[attachments, drainPromptQueue, operation?.status, runPrompt],
	);
	useEffect(() => {
		if (
			operation?.status === "queued" ||
			operation?.status === "running" ||
			promptRunning.current ||
			!promptQueue.current.length
		)
			return;
		void drainPromptQueue();
	}, [drainPromptQueue, operation?.status]);
	const steer = useCallback(
		async (text: string) => {
			const requestedWorkspace = workspaceId;
			if (!activeSessionId || !operation?.runId || sessionChanging) return;
			steeringPromptsRef.current = [...steeringPromptsRef.current, text];
			setSteeringPrompts(steeringPromptsRef.current);
			try {
				await callRpc("steer", {
					sessionId: activeSessionId,
					runId: operation?.runId,
					message: text,
					...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}),
				});
			} catch (cause) {
				steeringPromptsRef.current = steeringPromptsRef.current.filter((item) => item !== text);
				setSteeringPrompts(steeringPromptsRef.current);
				if (workspaceRef.current !== requestedWorkspace) return;
				setError(cause instanceof Error ? cause.message : "Unable to steer the active response.");
			} finally {
				for (const attachment of attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
				setAttachments([]);
			}
		},
		[attachments, activeSessionId, operation?.runId, sessionChanging, setError, callRpc, workspaceId],
	);
	const cancel = useCallback(async () => {
		const requestedWorkspace = workspaceId;
		if ((operation?.status === "running" || operation?.status === "queued") && operation.runId) {
			try {
				await callRpc<{ readonly cancelled: boolean }>("cancel", {
					sessionId: activeSessionId,
					runId: operation.runId,
					requestId: operation.requestId,
				});
			} catch (cause) {
				if (workspaceRef.current !== requestedWorkspace) return;
				setError(cause instanceof Error ? cause.message : "Unable to cancel the active response.");
			}
		}
	}, [operation, activeSessionId, setError, callRpc, workspaceId]);
	const compact = useCallback(async () => {
		const requestedWorkspace = workspaceId;
		if (!activeSessionId || sessionChanging) return;
		const requestId = crypto.randomUUID();
		setError(undefined);
		lastCompactionError.current = undefined;
		setCompaction({ state: "running", reason: "manual" });
		setOperation({ requestId, kind: "compact", status: "queued" });
		try {
			await callRpc("compact", { sessionId: activeSessionId }, requestId);
			await refresh();
			setOperation(undefined);
		} catch (cause) {
			if (workspaceRef.current !== requestedWorkspace) return;
			const message =
				lastCompactionError.current ??
				(cause instanceof Error ? cause.message : "Unable to compact the session context.");
			setCompaction({ state: "error", reason: "manual", error: message });
			setOperation({ requestId, kind: "compact", status: "failed", error: { code: "INTERNAL_ERROR", message } });
		}
	}, [refresh, activeSessionId, sessionChanging, setError, callRpc, workspaceId]);
	const runCommand = useCallback(
		async (name: string, args: string): Promise<CommandAction | undefined> => {
			const requestedWorkspace = workspaceId;
			if (!activeSessionId || sessionChanging) return undefined;
			try {
				const result = await callRpc<{ readonly action?: CommandAction }>("run_command", {
					sessionId: activeSessionId,
					name,
					args,
				});
				return result.action;
			} catch (cause) {
				if (workspaceRef.current !== requestedWorkspace) return undefined;
				setError(cause instanceof Error ? cause.message : "Unable to run the command.");
				return undefined;
			}
		},
		[activeSessionId, sessionChanging, setError, callRpc, workspaceId],
	);
	const navigateTree = useCallback(
		async (entryId: string): Promise<TreeNavigation | undefined> => {
			if (!activeSessionId || sessionChanging) return undefined;
			try {
				const result = await callRpc<{ readonly navigation: TreeNavigation }>("navigate_tree", {
					sessionId: activeSessionId,
					entryId,
				});
				await refresh();
				return result.navigation;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to navigate the session tree.");
				return undefined;
			}
		},
		[refresh, activeSessionId, sessionChanging, setError, callRpc],
	);
	const clearVisibleMessages = useCallback(() => {
		setMessages([]);
		setTools([]);
	}, []);
	const retry = useCallback(async () => {
		if (activeSessionId && !sessionChanging && (operation?.status === "failed" || operation?.status === "cancelled")) {
			try {
				await callRpc("retry", { sessionId: activeSessionId, targetRequestId: operation.requestId });
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to retry the response.");
			}
		}
	}, [operation, refresh, activeSessionId, sessionChanging, setError, callRpc]);
	const approveTool = useCallback(
		async (approvalId: string, approved: boolean) => {
			if (!activeSessionId || !operation?.runId || sessionChanging) return;
			try {
				const approval = approvals.find((item) => item.approvalId === approvalId);
				await callRpc(
					"approve_tool",
					{
						sessionId: activeSessionId,
						runId: operation?.runId,
						requestId: approval?.requestId,
						approvalId,
						approved,
					},
					crypto.randomUUID(),
				);
				setApprovals((current) =>
					current.map((item) =>
						item.approvalId === approvalId ? { ...item, state: approved ? "accepted" : "denied" } : item,
					),
				);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to submit tool approval.");
			}
		},
		[activeSessionId, approvals, operation, sessionChanging, setError, callRpc],
	);
	const respondInteraction = useCallback(
		async (
			requestId: string,
			result: {
				readonly status: "answered" | "cancelled" | "timeout";
				readonly value?: string;
				readonly approved?: boolean;
				readonly feedback?: string;
			},
		) => {
			if (!activeSessionId || !operation?.runId || sessionChanging) return;
			try {
				await sendInteractionResponse(activeSessionId ?? "", operation?.runId ?? "", requestId, result);
				setInteractions((current) => current.filter((item) => item.requestId !== requestId));
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to answer interaction.");
			}
		},
		[activeSessionId, operation?.runId, sessionChanging, setError],
	);
	const newSession = useCallback(async () => {
		const generation = ++sessionGeneration.current;
		const placeholderId = `pending-${crypto.randomUUID()}`;
		const placeholder: SessionSummary = {
			id: placeholderId,
			label: "New session",
			modifiedAt: new Date().toISOString(),
		};
		pendingSessions.current = [placeholder, ...pendingSessions.current];
		setSessions((current) => [placeholder, ...current]);
		setSessionChanging(true);
		setActiveSessionId(undefined);
		setMessages([]);
		setTools([]);
		setApprovals([]);
		setInteractions([]);
		setOperation(undefined);
		try {
			const result = await callRpc<{ readonly session: SessionSummary }>("new_session");
			if (sessionGeneration.current !== generation) {
				pendingSessions.current = pendingSessions.current.filter((session) => session.id !== placeholderId);
				setSessions((current) => current.filter((session) => session.id !== placeholderId));
				return;
			}
			pendingSessions.current = [
				result.session,
				...pendingSessions.current.filter((session) => session.id !== placeholderId),
			];
			setSessions((current) => [result.session, ...current.filter((session) => session.id !== placeholderId)]);
			setActiveSessionId(result.session.id);
			setSessionChanging(false);
			await refresh();
			pendingSessions.current = pendingSessions.current.filter((session) => session.id !== result.session.id);
		} catch (cause) {
			if (sessionGeneration.current !== generation) return;
			pendingSessions.current = pendingSessions.current.filter((session) => session.id !== placeholderId);
			setSessions((current) => current.filter((session) => session.id !== placeholderId));
			setActiveSessionId(undefined);
			setSessionChanging(false);
			setError(cause instanceof Error ? cause.message : "Unable to create a new session.");
		}
	}, [refresh, setError, callRpc]);
	const openSession = useCallback(
		async (id: string) => {
			if (!id || id.startsWith("pending-")) return;
			const key = `${workspaceId ?? ""}:${id}`;
			if (openingSessionKey.current === key) return;
			openingSessionKey.current = key;
			const generation = ++sessionGeneration.current;
			setSessionChanging(true);
			setActiveSessionId(undefined);
			setMessages([]);
			setTools([]);
			setApprovals([]);
			setInteractions([]);
			setOperation(undefined);
			try {
				const result = await callRpc<{ readonly session: SessionSummary }>("open_session", { sessionId: id });
				if (sessionGeneration.current !== generation) return;
				setActiveSessionId(result.session.id);
				setSessionChanging(false);
				// SessionHost emits session_changed before the RPC resolves. The event
				// path performs the snapshot refresh; only fall back when SSE is down.
				if (!connected) await refresh();
			} catch (cause) {
				if (sessionGeneration.current !== generation) return;
				setSessionChanging(false);
				setError(cause instanceof Error ? cause.message : "Unable to open the selected session.");
			} finally {
				if (openingSessionKey.current === key) openingSessionKey.current = undefined;
			}
		},
		[connected, refresh, setError, callRpc, workspaceId],
	);
	const rename = useCallback(
		async (id: string, label: string) => {
			try {
				await renameSession(id, label, workspaceId);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to rename the session.");
			}
		},
		[refresh, setError, workspaceId],
	);
	const remove = useCallback(
		async (id: string) => {
			pendingDeletedSessions.current = new Set(pendingDeletedSessions.current).add(id);
			setSessions((current) => current.filter((session) => session.id !== id));
			setRunningSessionIds((current) => {
				if (!current.has(id)) return current;
				const next = new Set(current);
				next.delete(id);
				return next;
			});
			const deletingActiveSession = activeSessionId === id;
			if (deletingActiveSession) {
				setActiveSessionId(undefined);
				setMessages([]);
				setTools([]);
				setApprovals([]);
				setInteractions([]);
				setOperation(undefined);
			}
			try {
				await deleteSession(id, workspaceId);
				const pending = new Set(pendingDeletedSessions.current);
				pending.delete(id);
				pendingDeletedSessions.current = pending;
				await refresh();
			} catch (cause) {
				const pending = new Set(pendingDeletedSessions.current);
				pending.delete(id);
				pendingDeletedSessions.current = pending;
				await refresh().catch(() => undefined);
				setError(cause instanceof Error ? cause.message : "Unable to delete the session.");
			}
		},
		[activeSessionId, refresh, setError, workspaceId],
	);
	const branch = useCallback(
		async (id: string, entryId?: string) => {
			try {
				const session = await branchSession(id, entryId, workspaceId);
				setActiveSessionId(session.id);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Unable to branch the session.");
			}
		},
		[refresh, setError, workspaceId],
	);
	const inspect = useCallback(async (id: string) => await inspectSession(id, workspaceId), [workspaceId]);
	const addFiles = useCallback(
		async (files: FileList | readonly File[]) => {
			if (!activeSessionId) throw new Error("Select a session before adding an attachment.");
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
					const info = await uploadAttachment(
						{
							sessionId: activeSessionId,
							name: file.name,
							contentType: file.type as AttachmentInfo["contentType"],
							data: encoded,
						},
						workspaceId,
					);
					setAttachments((current) => [...current, { ...info, previewUrl: URL.createObjectURL(file) }]);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : "Unable to upload attachment.");
				}
			}
		},
		[attachments.length, activeSessionId, setError, workspaceId],
	);

	return {
		sessions,
		activeSessionId,
		runningSessionIds,
		messages,
		tools,
		approvals,
		interactions,
		projections,
		contextFiles,
		commands,
		tree,
		compaction,
		usage,
		operation,
		queuedPrompts,
		steeringPrompts,
		attachments,
		connected,
		error,
		errorRevision,
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
		respondInteraction,
		sessionChanging,
	};
}
