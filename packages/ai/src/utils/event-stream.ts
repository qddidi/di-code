import type { AssistantMessage, StreamEvent } from "../types.ts";
import { createStreamEventValidator } from "./validation.ts";
export interface EventStreamOptions<TEvent, TResult> {
	validate(event: TEvent): void;
	isTerminal(event: TEvent): boolean;
	getResult(event: TEvent): TResult;
}

interface Waiter<TEvent> {
	resolve(result: IteratorResult<TEvent>): void;
	reject(cause: unknown): void;
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
	private readonly options: EventStreamOptions<TEvent, TResult>;
	private readonly queue: TEvent[] = [];
	private readonly waiters: Waiter<TEvent>[] = [];
	private readonly finalResultPromise: Promise<TResult>;
	private resolveFinalResult!: (result: TResult) => void;
	private rejectFinalResult!: (cause: unknown) => void;
	private terminal = false;
	private failure?: Error;
	private iteratorClaimed = false;

	constructor(options: EventStreamOptions<TEvent, TResult>) {
		this.options = options;
		this.finalResultPromise = new Promise<TResult>((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});

		void this.finalResultPromise.catch(() => undefined);
	}
	push(event: TEvent): void {
		this.assertCanPush();
		let terminalResult: { value: TResult } | undefined;
		try {
			this.options.validate(event);
			if (this.options.isTerminal(event)) {
				terminalResult = { value: this.options.getResult(event) };
			}
		} catch (cause) {
			const error = normalizeError(cause);
			this.fail(error);
			throw error;
		}

		if (terminalResult) {
			this.terminal = true;
			this.resolveFinalResult(terminalResult.value);
		}

		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}

		if (terminalResult) {
			while (this.waiters.length > 0) {
				const pendingWaiter = this.waiters.shift();
				pendingWaiter?.resolve({ value: undefined, done: true });
			}
		}
	}
	private assertCanPush(): void {
		if (this.failure) {
			throw this.failure;
		}
		if (this.terminal) {
			throw new Error("EventStream is already settled");
		}
	}
	fail(cause: unknown): void {
		if (this.failure) {
			return;
		}
		if (this.terminal) {
			throw new Error("EventStream is already settled");
		}

		const error = normalizeError(cause);
		this.failure = error;
		this.rejectFinalResult(error);

		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.reject(error);
		}
	}
	[Symbol.asyncIterator](): AsyncIterator<TEvent> {
		if (this.iteratorClaimed) {
			throw new Error("EventStream supports exactly one async iterator");
		}
		this.iteratorClaimed = true;

		return {
			next: () => this.nextEvent(),
		};
	}
	private nextEvent(): Promise<IteratorResult<TEvent>> {
		if (this.queue.length > 0) {
			const queuedEvent = this.queue.shift() as TEvent;
			return Promise.resolve({ value: queuedEvent, done: false });
		}

		if (this.failure) {
			return Promise.reject(this.failure);
		}

		if (this.terminal) {
			return Promise.resolve({ value: undefined, done: true });
		}

		return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}
	result(): Promise<TResult> {
		return this.finalResultPromise;
	}
}
export type AssistantMessageEventStream = EventStream<StreamEvent, AssistantMessage>;

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	const validator = createStreamEventValidator();

	return new EventStream<StreamEvent, AssistantMessage>({
		validate(event) {
			validator.accept(event);
		},
		isTerminal(event) {
			return event.type === "done" || event.type === "error";
		},
		getResult(event) {
			if (event.type === "done" || event.type === "error") {
				return event.message;
			}
			throw new Error("Expected terminal stream event");
		},
	});
}
