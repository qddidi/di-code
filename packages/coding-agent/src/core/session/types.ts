import type { Message } from "@di-code/ai";

export const SESSION_FORMAT_VERSION = 1 as const;

export interface SessionRecordBase {
	readonly version: typeof SESSION_FORMAT_VERSION;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface SessionHeader extends SessionRecordBase {
	readonly type: "session";
	readonly parentId: null;
	readonly cwd: string;
}

export interface SessionMessageEntry extends SessionRecordBase {
	readonly type: "message";
	readonly parentId: string;
	readonly message: Message;
}

export interface SessionSummaryEntry extends SessionRecordBase {
	readonly type: "summary";
	readonly parentId: string;
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
}

export type SessionEntry = SessionMessageEntry | SessionSummaryEntry;

export type SessionRecord = SessionHeader | SessionEntry;

export type SessionDiagnostic =
	| {
			readonly kind: "trailing_partial_line";
			readonly lineNumber: number;
			readonly reason: string;
	  }
	| {
			readonly kind: "corrupt_record";
			readonly lineNumber: number;
			readonly reason: string;
	  };

export interface LoadedSession {
	readonly header: SessionHeader;
	readonly entries: readonly SessionEntry[];
	readonly messages: readonly Message[];
	readonly diagnostics: readonly SessionDiagnostic[];
}

export type SessionLoadErrorCode = "INVALID_HEADER" | "UNSUPPORTED_VERSION" | "READ_FAILED";

export class SessionLoadError extends Error {
	readonly code: SessionLoadErrorCode;
	readonly filePath: string;
	readonly lineNumber?: number;

	constructor(
		code: SessionLoadErrorCode,
		filePath: string,
		message: string,
		options?: { readonly lineNumber?: number; readonly cause?: unknown },
	) {
		super(message, { cause: options?.cause });
		this.name = "SessionLoadError";
		this.code = code;
		this.filePath = filePath;
		this.lineNumber = options?.lineNumber;
	}
}

export type SessionWriteErrorCode =
	| "CREATE_FAILED"
	| "APPEND_FAILED"
	| "LOCK_TIMEOUT"
	| "CONCURRENT_MODIFICATION"
	| "CORRUPT_SESSION";

export class SessionWriteError extends Error {
	readonly code: SessionWriteErrorCode;
	readonly filePath: string;
	readonly expectedParentId?: string;
	readonly actualParentId?: string;

	constructor(
		code: SessionWriteErrorCode,
		filePath: string,
		message: string,
		options?: {
			readonly cause?: unknown;
			readonly expectedParentId?: string;
			readonly actualParentId?: string;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = "SessionWriteError";
		this.code = code;
		this.filePath = filePath;
		this.expectedParentId = options?.expectedParentId;
		this.actualParentId = options?.actualParentId;
	}
}
