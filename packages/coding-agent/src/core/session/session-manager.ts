import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Message } from "@di-code/ai";
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
	type SessionHeader,
	type SessionMessageEntry,
} from "./types.ts";

export interface SessionManagerCreateOptions {
	readonly filePath: string;
	readonly cwd: string;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly appendOptions?: SessionAppendOptions;
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
	private readonly sessionEntries: SessionMessageEntry[];
	private readonly sessionDiagnostics: SessionDiagnostic[];
	private appendQueue: Promise<void> = Promise.resolve();

	private constructor(filePath: string, loaded: LoadedSession, options: SessionManagerOpenOptions) {
		this.filePath = filePath;
		this.sessionHeader = structuredClone(loaded.header);
		this.sessionEntries = structuredClone([...loaded.entries]);
		this.sessionDiagnostics = structuredClone([...loaded.diagnostics]);
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.appendOptions = options.appendOptions ?? {};
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
		await createSessionFile(filePath, header);
		return new SessionManager(
			filePath,
			{ header, entries: [], messages: [], diagnostics: [] },
			{ now, createId, appendOptions: options.appendOptions },
		);
	}

	static async open(filePath: string, options: SessionManagerOpenOptions = {}): Promise<SessionManager> {
		const resolvedPath = resolve(filePath);
		return new SessionManager(resolvedPath, await loadSessionFile(resolvedPath), options);
	}

	get entries(): readonly SessionMessageEntry[] {
		return structuredClone(this.sessionEntries);
	}

	get header(): SessionHeader {
		return structuredClone(this.sessionHeader);
	}

	get messages(): readonly Message[] {
		return structuredClone(this.sessionEntries.map((entry) => entry.message));
	}

	get diagnostics(): readonly SessionDiagnostic[] {
		return structuredClone(this.sessionDiagnostics);
	}

	get leafId(): string {
		return this.sessionEntries.at(-1)?.id ?? this.sessionHeader.id;
	}

	appendMessage(message: Message): Promise<SessionMessageEntry> {
		const messageSnapshot = structuredClone(message);
		const operation = this.appendQueue.then(async () => {
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
			return structuredClone(entry);
		});

		this.appendQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}
