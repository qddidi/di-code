import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import type { AssistantContent, AssistantMessage, Message, ToolResultContent, Usage, UserContent } from "@di-code/ai";
import {
	type LoadedSession,
	SESSION_FORMAT_VERSION,
	type SessionEntry,
	type SessionHeader,
	SessionLoadError,
	type SessionMessageEntry,
	type SessionSummaryEntry,
	SessionWriteError,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && isNonNegativeNumber(value);
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecordId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function isAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && (win32.isAbsolute(value) || posix.isAbsolute(value));
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isObject(value) && Object.values(value).every(isJsonValue);
}

function isProviderReplay(value: unknown): boolean {
	return isObject(value) && isNonEmptyString(value.api) && isJsonValue(value.data);
}

function isImageContent(value: unknown): value is Extract<UserContent | ToolResultContent, { type: "image" }> {
	return (
		isObject(value) && value.type === "image" && typeof value.data === "string" && isNonEmptyString(value.mimeType)
	);
}

function isTextContent(value: unknown): value is Extract<UserContent, { type: "text" }> {
	return isObject(value) && value.type === "text" && typeof value.text === "string";
}

function isUserContent(value: unknown): value is UserContent {
	return isTextContent(value) || isImageContent(value);
}

function isAssistantContent(value: unknown): value is AssistantContent {
	if (!isObject(value)) return false;
	switch (value.type) {
		case "text":
			return typeof value.text === "string";
		case "thinking":
			return typeof value.thinking === "string";
		case "tool_call":
			return (
				isNonEmptyString(value.id) &&
				isNonEmptyString(value.name) &&
				isObject(value.arguments) &&
				isJsonValue(value.arguments)
			);
		default:
			return false;
	}
}

function isToolResultContent(value: unknown): value is ToolResultContent {
	return isTextContent(value) || isImageContent(value);
}

function isUsage(value: unknown): value is Usage {
	if (!isObject(value) || !isObject(value.cost)) return false;
	return (
		isNonNegativeNumber(value.input) &&
		isNonNegativeNumber(value.output) &&
		isNonNegativeNumber(value.cacheRead) &&
		isNonNegativeNumber(value.cacheWrite) &&
		isNonNegativeNumber(value.totalTokens) &&
		isNonNegativeNumber(value.cost.input) &&
		isNonNegativeNumber(value.cost.output) &&
		isNonNegativeNumber(value.cost.cacheRead) &&
		isNonNegativeNumber(value.cost.cacheWrite) &&
		isNonNegativeNumber(value.cost.total)
	);
}

function isAssistantMessage(value: JsonObject): value is JsonObject & AssistantMessage {
	if (
		value.role !== "assistant" ||
		!Array.isArray(value.content) ||
		!value.content.every(isAssistantContent) ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.model) ||
		(value.providerReplay !== undefined && !isProviderReplay(value.providerReplay)) ||
		!isUsage(value.usage) ||
		!isTimestamp(value.timestamp)
	) {
		return false;
	}

	if (value.stopReason === "stop" || value.stopReason === "length" || value.stopReason === "tool_use") {
		return value.errorMessage === undefined;
	}
	if (value.stopReason === "error" || value.stopReason === "aborted") {
		return typeof value.errorMessage === "string";
	}
	return false;
}

function isMessage(value: unknown): value is Message {
	if (!isObject(value) || !isTimestamp(value.timestamp)) return false;

	switch (value.role) {
		case "user":
			return Array.isArray(value.content) && value.content.every(isUserContent);
		case "assistant":
			return isAssistantMessage(value);
		case "tool_result":
			return (
				isNonEmptyString(value.toolCallId) &&
				isNonEmptyString(value.toolName) &&
				Array.isArray(value.content) &&
				value.content.every(isToolResultContent) &&
				typeof value.isError === "boolean"
			);
		default:
			return false;
	}
}

function decodeHeader(value: unknown, filePath: string): SessionHeader {
	if (!isObject(value) || value.type !== "session") {
		throw new SessionLoadError("INVALID_HEADER", filePath, `Invalid session header in "${filePath}".`, {
			lineNumber: 1,
		});
	}
	if (!("version" in value)) {
		throw new SessionLoadError("INVALID_HEADER", filePath, `Session header has no version in "${filePath}".`, {
			lineNumber: 1,
		});
	}
	if (value.version !== SESSION_FORMAT_VERSION) {
		throw new SessionLoadError(
			"UNSUPPORTED_VERSION",
			filePath,
			`Unsupported session version ${JSON.stringify(value.version)} in "${filePath}".`,
			{ lineNumber: 1 },
		);
	}
	if (
		!isRecordId(value.id) ||
		value.parentId !== null ||
		!isIsoTimestamp(value.timestamp) ||
		!isAbsolutePath(value.cwd)
	) {
		throw new SessionLoadError("INVALID_HEADER", filePath, `Invalid session header fields in "${filePath}".`, {
			lineNumber: 1,
		});
	}
	return value as unknown as SessionHeader;
}

function decodeSessionEntry(value: unknown): { readonly entry?: SessionEntry; readonly reason?: string } {
	if (!isObject(value) || (value.type !== "message" && value.type !== "summary")) {
		return { reason: 'record type must be "message" or "summary"' };
	}
	if (value.version !== SESSION_FORMAT_VERSION) return { reason: "record version must be 1" };
	if (!isRecordId(value.id)) return { reason: "record id is invalid" };
	if (!isRecordId(value.parentId)) return { reason: "record parentId is invalid" };
	if (!isIsoTimestamp(value.timestamp)) return { reason: "record timestamp is not canonical ISO 8601 UTC" };
	if (value.type === "message") {
		if (!isMessage(value.message)) return { reason: "record message does not match the Message contract" };
		return { entry: value as unknown as SessionMessageEntry };
	}
	if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
		return { reason: "record summary must be a non-empty string" };
	}
	if (!isRecordId(value.firstKeptEntryId)) return { reason: "record firstKeptEntryId is invalid" };
	if (!Number.isSafeInteger(value.tokensBefore) || !isNonNegativeNumber(value.tokensBefore)) {
		return { reason: "record tokensBefore must be a non-negative safe integer" };
	}
	return { entry: value as unknown as SessionSummaryEntry };
}

function withoutTrailingCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export async function loadSessionFile(filePath: string): Promise<LoadedSession> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (cause) {
		throw new SessionLoadError("READ_FAILED", filePath, `Failed to read session file "${filePath}".`, { cause });
	}

	const physicalLines = content.split("\n");
	let partialLineNumber: number | undefined;
	if (content.endsWith("\n")) {
		physicalLines.pop();
	} else {
		physicalLines.pop();
		partialLineNumber = physicalLines.length + 1;
	}

	if (physicalLines.length === 0) {
		throw new SessionLoadError("INVALID_HEADER", filePath, `Session file has no committed header: "${filePath}".`, {
			lineNumber: 1,
		});
	}

	let headerValue: unknown;
	try {
		headerValue = JSON.parse(withoutTrailingCarriageReturn(physicalLines[0] ?? "")) as unknown;
	} catch (cause) {
		throw new SessionLoadError("INVALID_HEADER", filePath, `Session header is not valid JSON in "${filePath}".`, {
			lineNumber: 1,
			cause,
		});
	}

	const header = decodeHeader(headerValue, filePath);
	const entries: SessionEntry[] = [];
	const diagnostics: LoadedSession["diagnostics"][number][] = [];
	const seenIds = new Set<string>([header.id]);
	const messageEntryIds = new Set<string>();
	let expectedParentId = header.id;

	for (let index = 1; index < physicalLines.length; index++) {
		const lineNumber = index + 1;
		try {
			const value = JSON.parse(withoutTrailingCarriageReturn(physicalLines[index] ?? "")) as unknown;
			const decoded = decodeSessionEntry(value);
			if (!decoded.entry) throw new Error(decoded.reason ?? "Invalid session message record.");
			if (seenIds.has(decoded.entry.id)) throw new Error("record id is duplicated");
			if (decoded.entry.parentId !== expectedParentId) {
				throw new Error(`record parentId must be "${expectedParentId}"`);
			}
			if (decoded.entry.type === "summary" && !messageEntryIds.has(decoded.entry.firstKeptEntryId)) {
				throw new Error("record firstKeptEntryId must reference an earlier message entry");
			}
			entries.push(decoded.entry);
			seenIds.add(decoded.entry.id);
			if (decoded.entry.type === "message") messageEntryIds.add(decoded.entry.id);
			expectedParentId = decoded.entry.id;
		} catch (cause) {
			diagnostics.push({ kind: "corrupt_record", lineNumber, reason: errorText(cause) });
			break;
		}
	}

	if (diagnostics.length === 0 && partialLineNumber !== undefined) {
		diagnostics.push({
			kind: "trailing_partial_line",
			lineNumber: partialLineNumber,
			reason: "final line has no newline commit marker",
		});
	}

	return {
		header,
		entries,
		messages: entries
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message),
		diagnostics,
	};
}

export interface SessionAppendOptions {
	readonly lockTimeoutMs?: number;
	readonly lockRetryMs?: number;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 25;

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function createSessionFile(filePath: string, header: SessionHeader): Promise<void> {
	const headerSnapshot = structuredClone(header);
	try {
		decodeHeader(headerSnapshot, filePath);
		await mkdir(dirname(filePath), { recursive: true });
		const handle = await open(filePath, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(headerSnapshot)}\n`, "utf8");
		} finally {
			await handle.close();
		}
	} catch (cause) {
		if (cause instanceof SessionWriteError) throw cause;
		throw new SessionWriteError("CREATE_FAILED", filePath, `Failed to create session file "${filePath}".`, {
			cause,
		});
	}
}

async function acquireLock(filePath: string, options: SessionAppendOptions) {
	const lockPath = `${filePath}.lock`;
	const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const retry = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? delay;
	const startedAt = now();

	while (true) {
		try {
			return { handle: await open(lockPath, "wx"), lockPath };
		} catch (cause) {
			if (!isNodeError(cause) || cause.code !== "EEXIST") {
				throw new SessionWriteError("APPEND_FAILED", filePath, `Failed to acquire session lock for "${filePath}".`, {
					cause,
				});
			}
			if (now() - startedAt >= timeout) {
				throw new SessionWriteError("LOCK_TIMEOUT", filePath, `Timed out waiting for session lock "${lockPath}".`, {
					cause,
				});
			}
			await sleep(retry);
		}
	}
}

async function releaseLock(handle: Awaited<ReturnType<typeof open>>, lockPath: string): Promise<void> {
	let closeError: unknown;
	try {
		await handle.close();
	} catch (cause) {
		closeError = cause;
	}

	try {
		await unlink(lockPath);
	} catch (cause) {
		if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
	}

	if (closeError !== undefined) throw closeError;
}

export async function appendSessionEntry(
	filePath: string,
	entry: SessionEntry,
	expectedParentId: string,
	options: SessionAppendOptions = {},
): Promise<void> {
	const entrySnapshot = structuredClone(entry);
	const decodedEntry = decodeSessionEntry(entrySnapshot);
	if (!decodedEntry.entry) {
		throw new SessionWriteError(
			"APPEND_FAILED",
			filePath,
			`Refusing to append an invalid session entry to "${filePath}": ${decodedEntry.reason ?? "invalid record"}.`,
		);
	}
	const { handle, lockPath } = await acquireLock(filePath, options);
	let operationError: unknown;
	try {
		const loaded = await loadSessionFile(filePath);
		if (loaded.diagnostics.length > 0) {
			throw new SessionWriteError(
				"CORRUPT_SESSION",
				filePath,
				`Refusing to append to a session with recovery diagnostics: "${filePath}".`,
			);
		}

		const actualParentId = loaded.entries.at(-1)?.id ?? loaded.header.id;
		if (
			entrySnapshot.type === "summary" &&
			!loaded.entries.some(
				(existing): existing is SessionMessageEntry =>
					existing.type === "message" && existing.id === entrySnapshot.firstKeptEntryId,
			)
		) {
			throw new SessionWriteError(
				"APPEND_FAILED",
				filePath,
				`Refusing to append a summary with an invalid firstKeptEntryId to "${filePath}".`,
			);
		}
		if (loaded.header.id === entrySnapshot.id || loaded.entries.some((existing) => existing.id === entrySnapshot.id)) {
			throw new SessionWriteError(
				"APPEND_FAILED",
				filePath,
				`Refusing to append a duplicate session record id to "${filePath}".`,
			);
		}
		if (actualParentId !== expectedParentId || entrySnapshot.parentId !== expectedParentId) {
			throw new SessionWriteError(
				"CONCURRENT_MODIFICATION",
				filePath,
				`Session leaf changed before append in "${filePath}".`,
				{ expectedParentId, actualParentId },
			);
		}

		await appendFile(filePath, `${JSON.stringify(entrySnapshot)}\n`, "utf8");
	} catch (cause) {
		operationError = cause;
	} finally {
		try {
			await releaseLock(handle, lockPath);
		} catch (cause) {
			operationError ??= new SessionWriteError(
				"APPEND_FAILED",
				filePath,
				`Failed to release session lock for "${filePath}".`,
				{ cause },
			);
		}
	}

	if (operationError !== undefined) {
		if (operationError instanceof SessionWriteError) {
			throw operationError;
		}
		if (operationError instanceof SessionLoadError) {
			const code = operationError.code === "READ_FAILED" ? "APPEND_FAILED" : "CORRUPT_SESSION";
			throw new SessionWriteError(code, filePath, `Unable to load session before append: "${filePath}".`, {
				cause: operationError,
			});
		}
		throw new SessionWriteError("APPEND_FAILED", filePath, `Failed to append session entry to "${filePath}".`, {
			cause: operationError,
		});
	}
}
