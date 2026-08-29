export const USER_INTERACTION_API_VERSION = 1 as const;

export type UserInteractionKind = "question" | "questions" | "choice" | "approval";
export type UserInteractionIntent = "ask-user" | "tool-approval" | "plan-review" | "settings";
export type UserInteractionStatus = "answered" | "cancelled" | "timeout" | "unavailable" | "disposed";

export interface UserInteractionOption {
	readonly value: string;
	readonly label: string;
}

export interface UserInteractionQuestion {
	readonly id: string;
	readonly prompt: string;
	readonly options?: readonly UserInteractionOption[];
	readonly allowFreeText?: boolean;
}

export interface UserInteractionInput {
	readonly requestId: string;
	readonly toolCallId?: string;
	readonly kind: UserInteractionKind;
	readonly prompt: string;
	readonly questions?: readonly UserInteractionQuestion[];
	readonly options?: readonly UserInteractionOption[];
	readonly intent?: UserInteractionIntent;
	readonly timeoutMs?: number;
}

export interface UserInteractionResult {
	readonly requestId: string;
	readonly toolCallId?: string;
	readonly status: UserInteractionStatus;
	readonly approved?: boolean;
	readonly value?: string;
	readonly values?: Readonly<Record<string, string>>;
	readonly feedback?: string;
}

export interface UserInteractionProvider {
	readonly request: (input: UserInteractionInput, signal: AbortSignal) => Promise<UserInteractionResult>;
	readonly respond?: (requestId: string, result: UserInteractionResult) => boolean;
	readonly dispose?: () => void | Promise<void>;
}

export interface UserInteraction {
	readonly request: (
		input: Omit<UserInteractionInput, "requestId"> & { readonly requestId?: string },
		signal?: AbortSignal,
	) => Promise<UserInteractionResult>;
	readonly answer: (requestId: string, result: Omit<UserInteractionResult, "requestId">) => boolean;
	readonly dispose: () => Promise<void>;
}

export class UserInteractionError extends Error {
	readonly code: "INTERACTION_UNAVAILABLE" | "INTERACTION_CANCELLED" | "INTERACTION_TIMEOUT" | "INTERACTION_DISPOSED";
	constructor(code: UserInteractionError["code"], message: string) {
		super(message);
		this.name = "UserInteractionError";
		this.code = code;
	}
}

export function createUserInteraction(provider?: UserInteractionProvider): UserInteraction {
	const pending = new Map<string, Promise<UserInteractionResult>>();
	const controllers = new Map<string, AbortController>();
	let disposed = false;
	let nextId = 0;
	return {
		request: async (input, signal) => {
			if (disposed) throw new UserInteractionError("INTERACTION_DISPOSED", "User interaction is disposed.");
			const requestId = input.requestId ?? `interaction-${++nextId}`;
			const existing = pending.get(requestId);
			if (existing) return existing;
			if (!provider)
				throw new UserInteractionError("INTERACTION_UNAVAILABLE", "No user interaction channel is available.");
			const controller = new AbortController();
			controllers.set(requestId, controller);
			const abort = () => controller.abort(signal?.reason);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			const timeout =
				input.timeoutMs === undefined
					? undefined
					: setTimeout(
							() => controller.abort(new UserInteractionError("INTERACTION_TIMEOUT", "User interaction timed out.")),
							input.timeoutMs,
						);
			const promise = provider
				.request({ ...input, requestId }, controller.signal)
				.then((result) => ({ ...result, requestId, toolCallId: input.toolCallId ?? result.toolCallId }));
			pending.set(requestId, promise);
			try {
				return await promise;
			} catch (cause) {
				if (controller.signal.aborted) {
					if (disposed) throw new UserInteractionError("INTERACTION_DISPOSED", "User interaction is disposed.");
					if (signal?.aborted)
						throw new UserInteractionError("INTERACTION_CANCELLED", "User interaction was cancelled.");
					throw new UserInteractionError("INTERACTION_TIMEOUT", "User interaction timed out.");
				}
				throw cause;
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
				pending.delete(requestId);
				controllers.delete(requestId);
			}
		},
		answer: (requestId, result) => provider?.respond?.(requestId, { ...result, requestId }) ?? false,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			for (const controller of controllers.values())
				controller.abort(new UserInteractionError("INTERACTION_DISPOSED", "User interaction is disposed."));
			controllers.clear();
			await provider?.dispose?.();
		},
	};
}

export function createFakeInteractionProvider(): UserInteractionProvider & {
	readonly requests: readonly UserInteractionInput[];
	answer(requestId: string, result: Omit<UserInteractionResult, "requestId">): boolean;
} {
	const requests: UserInteractionInput[] = [];
	const waiters = new Map<string, (result: UserInteractionResult) => void>();
	const answered = new Map<string, UserInteractionResult>();
	return {
		requests,
		request: (input, signal) => {
			requests.push(structuredClone(input));
			const prior = answered.get(input.requestId);
			if (prior) return Promise.resolve(prior);
			return new Promise<UserInteractionResult>((resolve, reject) => {
				waiters.set(input.requestId, resolve);
				signal.addEventListener(
					"abort",
					() => {
						waiters.delete(input.requestId);
						reject(signal.reason ?? new Error("aborted"));
					},
					{ once: true },
				);
			});
		},
		respond: (requestId, result) => {
			if (answered.has(requestId)) return true;
			const waiter = waiters.get(requestId);
			if (!waiter) return false;
			const answer = { ...result, requestId };
			answered.set(requestId, answer);
			waiters.delete(requestId);
			waiter(answer);
			return true;
		},
		answer(requestId, result) {
			return this.respond?.(requestId, { ...result, requestId }) ?? false;
		},
	};
}
