import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Message } from "@di-code/ai";
import { type BuiltSessionContext, buildSessionContext } from "../context-builder.ts";
import {
	appendSessionEntry,
	createSessionFile,
	loadSessionFile,
	type SessionAppendOptions,
} from "./session-storage.ts";
import {
	type LoadedSession,
	SESSION_FORMAT_VERSION,
	type SessionDiagnostic,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
	type SessionSubagentEntry,
	type SessionSummaryEntry,
	type SessionTreeNode,
} from "./types.ts";

export interface SessionManagerCreateOptions {
	readonly filePath: string;
	readonly cwd: string;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly appendOptions?: SessionAppendOptions;
	readonly deferCreate?: boolean;
}

export interface SessionManagerOpenOptions {
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly appendOptions?: SessionAppendOptions;
}

function assertRecordId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(`Generated session record id is invalid: ${JSON.stringify(id)}.`);
	}
}

function createIsoTimestamp(now: () => number): string {
	const milliseconds = now();
	if (!Number.isFinite(milliseconds)) {
		throw new Error("Session clock must return a finite Unix millisecond timestamp.");
	}
	return new Date(milliseconds).toISOString();
}

export class SessionManager {
	readonly filePath: string;
	private readonly sessionHeader: SessionHeader;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly appendOptions: SessionAppendOptions;
	private readonly sessionEntries: SessionEntry[];
	private readonly entriesById = new Map<string, SessionEntry>();
	private readonly childrenByParentId = new Map<string, string[]>();
	private readonly sessionDiagnostics: SessionDiagnostic[];
	private activeLeafId: string;
	private fileCreated: boolean;
	private appendQueue: Promise<void> = Promise.resolve();

	private constructor(filePath: string, loaded: LoadedSession, options: SessionManagerOpenOptions, fileCreated = true) {
		this.filePath = filePath;
		this.sessionHeader = structuredClone(loaded.header);
		this.sessionEntries = structuredClone([...loaded.entries]);
		for (const entry of this.sessionEntries) this.addToIndexes(entry);
		this.activeLeafId = this.sessionEntries.at(-1)?.id ?? this.sessionHeader.id;
		this.sessionDiagnostics = structuredClone([...loaded.diagnostics]);
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.appendOptions = options.appendOptions ?? {};
		this.fileCreated = fileCreated;
	}

	static async create(options: SessionManagerCreateOptions): Promise<SessionManager> {
		const filePath = resolve(options.filePath);
		const cwd = resolve(options.cwd);
		const now = options.now ?? Date.now;
		const createId = options.createId ?? randomUUID;
		const id = createId();
		assertRecordId(id);
		const header: SessionHeader = {
			type: "session",
			version: SESSION_FORMAT_VERSION,
			id,
			parentId: null,
			timestamp: createIsoTimestamp(now),
			cwd,
		};
		if (!options.deferCreate) await createSessionFile(filePath, header);
		return new SessionManager(
			filePath,
			{ header, entries: [], messages: [], diagnostics: [] },
			{ now, createId, appendOptions: options.appendOptions },
			!options.deferCreate,
		);
	}

	static async open(filePath: string, options: SessionManagerOpenOptions = {}): Promise<SessionManager> {
		const resolvedPath = resolve(filePath);
		return new SessionManager(resolvedPath, await loadSessionFile(resolvedPath), options);
	}

	get entries(): readonly SessionEntry[] {
		return structuredClone(this.sessionEntries);
	}

	get header(): SessionHeader {
		return structuredClone(this.sessionHeader);
	}

	get messages(): readonly Message[] {
		return structuredClone(
			this.sessionEntries
				.filter((entry): entry is SessionMessageEntry => entry.type === "message")
				.map((entry) => entry.message),
		);
	}

	getEntry(id: string): SessionEntry | undefined {
		const entry = this.entriesById.get(id);
		return entry ? structuredClone(entry) : undefined;
	}

	getTree(): readonly SessionTreeNode[] {
		const nodes = new Map<string, { entry: SessionEntry; children: SessionTreeNode[] }>();
		const roots: SessionTreeNode[] = [];
		for (const entry of this.sessionEntries) {
			const node = { entry: structuredClone(entry), children: [] as SessionTreeNode[] };
			nodes.set(entry.id, node);
			if (entry.parentId === this.sessionHeader.id) {
				roots.push(node);
				continue;
			}
			const parent = nodes.get(entry.parentId);
			if (!parent) throw new Error(`Session tree parent "${entry.parentId}" is missing.`);
			parent.children.push(node);
		}
		return roots;
	}

	getBranch(leafId = this.activeLeafId): readonly SessionEntry[] {
		const branch: SessionEntry[] = [];
		let currentId = leafId;
		while (currentId !== this.sessionHeader.id) {
			const entry = this.entriesById.get(currentId);
			if (!entry) throw new Error(`Unknown session leaf "${currentId}".`);
			branch.push(structuredClone(entry));
			if (entry.parentId === null) throw new Error("Session entry parentId cannot be null.");
			currentId = entry.parentId;
		}
		branch.reverse();
		return branch;
	}

	setLeaf(id: string): void {
		if (id !== this.sessionHeader.id && !this.entriesById.has(id)) throw new Error(`Unknown session leaf "${id}".`);
		this.activeLeafId = id;
	}

	resetLeaf(): void {
		this.activeLeafId = this.sessionEntries.at(-1)?.id ?? this.sessionHeader.id;
	}

	buildContext(leafId = this.activeLeafId): BuiltSessionContext {
		return buildSessionContext(this.getBranch(leafId));
	}

	get latestSummary(): SessionSummaryEntry | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry?.type === "summary") return structuredClone(entry);
		}
		return undefined;
	}

	get diagnostics(): readonly SessionDiagnostic[] {
		return structuredClone(this.sessionDiagnostics);
	}

	get leafId(): string {
		return this.activeLeafId;
	}

	private async ensureFileCreated(): Promise<void> {
		if (this.fileCreated) return;
		await createSessionFile(this.filePath, this.sessionHeader);
		this.fileCreated = true;
	}

	appendMessage(message: Message): Promise<SessionMessageEntry> {
		const messageSnapshot = structuredClone(message);
		const operation = this.appendQueue.then(async () => {
			await this.ensureFileCreated();
			const id = this.createId();
			assertRecordId(id);
			const expectedParentId = this.leafId;
			const entry: SessionMessageEntry = {
				type: "message",
				version: SESSION_FORMAT_VERSION,
				id,
				parentId: expectedParentId,
				timestamp: createIsoTimestamp(this.now),
				message: messageSnapshot,
			};
			await appendSessionEntry(this.filePath, entry, expectedParentId, this.appendOptions);
			this.sessionEntries.push(structuredClone(entry));
			this.addToIndexes(entry);
			this.activeLeafId = entry.id;
			return structuredClone(entry);
		});

		this.appendQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	appendSummary(input: {
		readonly summary: string;
		readonly firstKeptEntryId: string;
		readonly tokensBefore: number;
	}): Promise<SessionSummaryEntry> {
		const inputSnapshot = structuredClone(input);
		const operation = this.appendQueue.then(async () => {
			await this.ensureFileCreated();
			const id = this.createId();
			assertRecordId(id);
			const expectedParentId = this.leafId;
			const entry: SessionSummaryEntry = {
				type: "summary",
				version: SESSION_FORMAT_VERSION,
				id,
				parentId: expectedParentId,
				timestamp: createIsoTimestamp(this.now),
				summary: inputSnapshot.summary,
				firstKeptEntryId: inputSnapshot.firstKeptEntryId,
				tokensBefore: inputSnapshot.tokensBefore,
			};
			await appendSessionEntry(this.filePath, entry, expectedParentId, this.appendOptions);
			this.sessionEntries.push(structuredClone(entry));
			this.addToIndexes(entry);
			this.activeLeafId = entry.id;
			return structuredClone(entry);
		});

		this.appendQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	appendSubagent(
		input: Omit<SessionSubagentEntry, "type" | "version" | "id" | "parentId" | "timestamp">,
	): Promise<SessionSubagentEntry> {
		const inputSnapshot = structuredClone(input);
		const operation = this.appendQueue.then(async () => {
			await this.ensureFileCreated();
			const id = this.createId();
			assertRecordId(id);
			const expectedParentId = this.leafId;
			const entry: SessionSubagentEntry = {
				type: "subagent",
				version: SESSION_FORMAT_VERSION,
				id,
				parentId: expectedParentId,
				timestamp: createIsoTimestamp(this.now),
				...inputSnapshot,
			};
			await appendSessionEntry(this.filePath, entry, expectedParentId, this.appendOptions);
			this.sessionEntries.push(structuredClone(entry));
			this.addToIndexes(entry);
			this.activeLeafId = entry.id;
			return structuredClone(entry);
		});
		this.appendQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private addToIndexes(entry: SessionEntry): void {
		this.entriesById.set(entry.id, structuredClone(entry));
		const children = this.childrenByParentId.get(entry.parentId) ?? [];
		children.push(entry.id);
		if (entry.parentId !== null) this.childrenByParentId.set(entry.parentId, children);
	}
}
