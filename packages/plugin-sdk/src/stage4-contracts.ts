import type { Disposer } from "@di-code/plugin-runtime";

export type SessionJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly SessionJsonValue[]
	| { readonly [key: string]: SessionJsonValue };

export const SESSION_EVENT_API_VERSION = 1 as const;
export const SESSION_EVENT_MAX_PAYLOAD_BYTES = 256 * 1024;

export interface SessionEventEnvelope {
	readonly namespace: string;
	readonly eventName: string;
	readonly schemaVersion: number;
	readonly payload: SessionJsonValue;
}

export type SessionEventValidator = (payload: unknown) => boolean;
export type SessionEventMigrator = (payload: SessionJsonValue, fromVersion: number) => SessionJsonValue;

export interface SessionEventDefinition<State = unknown> {
	readonly namespace: string;
	readonly eventName: string;
	readonly schemaVersion: number;
	readonly owner?: string;
	readonly validate: SessionEventValidator;
	readonly migrate?: SessionEventMigrator;
	readonly fold?: (state: State, event: SessionEventEnvelope) => State;
	readonly apply?: (state: State, event: SessionEventEnvelope) => State;
	readonly initialState?: State | (() => State);
}

export interface SessionEventRegistry {
	readonly register: <State>(definition: SessionEventDefinition<State>) => Disposer;
	readonly snapshot: () => readonly SessionEventDefinition[];
	readonly resolve: (namespace: string, eventName: string) => SessionEventDefinition | undefined;
	readonly migrate: (event: SessionEventEnvelope) => SessionEventEnvelope;
	readonly diagnostics: (events: readonly SessionEventEnvelope[]) => readonly string[];
	readonly subscribe: (listener: (definition: SessionEventDefinition, active: boolean) => void) => Disposer;
	readonly clear: () => void;
}

function eventKey(namespace: string, eventName: string): string {
	return `${namespace}:${eventName}`;
}

function assertName(value: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new TypeError(`${label} is invalid.`);
}

export function createSessionEventRegistry(): SessionEventRegistry {
	const definitions = new Map<string, SessionEventDefinition<unknown>>();
	const listeners = new Set<(definition: SessionEventDefinition, active: boolean) => void>();
	return {
		register(definition) {
			assertName(definition.namespace, "Session event namespace");
			assertName(definition.eventName, "Session event name");
			if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 0)
				throw new TypeError("Session event schemaVersion must be a non-negative safe integer.");
			if (typeof definition.validate !== "function") throw new TypeError("Session event validator is required.");
			const key = eventKey(definition.namespace, definition.eventName);
			if (definitions.has(key)) throw new Error(`Duplicate Session event: ${key}`);
			definitions.set(key, definition as unknown as SessionEventDefinition<unknown>);
			for (const listener of listeners) listener(definition as unknown as SessionEventDefinition, true);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (definitions.get(key) === definition) {
					definitions.delete(key);
					for (const listener of listeners) listener(definition as unknown as SessionEventDefinition, false);
				}
			};
		},
		snapshot: () => Object.freeze([...definitions.values()]),
		resolve: (namespace, eventName) => definitions.get(eventKey(namespace, eventName)),
		migrate(event) {
			const definition = definitions.get(eventKey(event.namespace, event.eventName));
			if (!definition) return structuredClone(event);
			const validate = (payload: SessionJsonValue): void => {
				const result = definition.validate(payload);
				if (result !== true) throw new Error(`Invalid payload for ${event.namespace}:${event.eventName}`);
			};
			if (event.schemaVersion === definition.schemaVersion) {
				validate(event.payload);
				return structuredClone(event);
			}
			if (event.schemaVersion > definition.schemaVersion || !definition.migrate)
				throw new Error(`Unsupported schema version ${event.schemaVersion} for ${event.namespace}:${event.eventName}`);
			const payload = definition.migrate(event.payload, event.schemaVersion);
			validate(payload);
			return { ...structuredClone(event), schemaVersion: definition.schemaVersion, payload };
		},
		diagnostics(events) {
			const diagnostics: string[] = [];
			for (const event of events) {
				const definition = definitions.get(eventKey(event.namespace, event.eventName));
				if (!definition) {
					diagnostics.push(`Unknown Session event ${event.namespace}:${event.eventName}`);
					continue;
				}
				try {
					this.migrate(event);
				} catch (error) {
					diagnostics.push(error instanceof Error ? error.message : String(error));
				}
			}
			return Object.freeze(diagnostics);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			for (const definition of [...definitions.values()]) {
				definitions.delete(eventKey(definition.namespace, definition.eventName));
				for (const listener of listeners) listener(definition, false);
			}
		},
	};
}

export interface SessionProjectionDefinition<State = unknown> {
	readonly namespace: string;
	readonly projectionName: string;
	readonly version: number;
	readonly eventNames?: readonly string[];
	readonly initialState: State | (() => State);
	readonly apply: (state: State, event: SessionEventEnvelope) => State;
}

export interface SessionProjectionSnapshot {
	readonly namespace: string;
	readonly projectionName: string;
	readonly version: number;
	readonly state: unknown;
	readonly appliedEvents: number;
}

export interface SessionProjectionRegistry {
	readonly register: <State>(definition: SessionProjectionDefinition<State>) => Disposer;
	readonly snapshot: () => readonly SessionProjectionDefinition[];
	readonly replay: (
		events: readonly SessionEventEnvelope[],
		eventRegistry?: SessionEventRegistry,
	) => readonly SessionProjectionSnapshot[];
	readonly subscribe: (listener: (definition: SessionProjectionDefinition, active: boolean) => void) => Disposer;
	readonly clear: () => void;
}

export function createSessionProjectionRegistry(): SessionProjectionRegistry {
	const definitions = new Map<string, SessionProjectionDefinition<unknown>>();
	const listeners = new Set<(definition: SessionProjectionDefinition, active: boolean) => void>();
	return {
		register(definition) {
			assertName(definition.namespace, "Session projection namespace");
			assertName(definition.projectionName, "Session projection name");
			if (!Number.isSafeInteger(definition.version) || definition.version < 0)
				throw new TypeError("Session projection version must be a non-negative safe integer.");
			if (typeof definition.apply !== "function") throw new TypeError("Session projection apply is required.");
			const key = eventKey(definition.namespace, definition.projectionName);
			if (definitions.has(key)) throw new Error(`Duplicate Session projection: ${key}`);
			definitions.set(key, definition as unknown as SessionProjectionDefinition<unknown>);
			for (const listener of listeners) listener(definition as unknown as SessionProjectionDefinition, true);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (definitions.get(key) === definition) {
					definitions.delete(key);
					for (const listener of listeners) listener(definition as unknown as SessionProjectionDefinition, false);
				}
			};
		},
		snapshot: () => Object.freeze([...definitions.values()]),
		replay(events, eventRegistry) {
			return Object.freeze(
				[...definitions.values()].map((definition) => {
					let state =
						typeof definition.initialState === "function"
							? (definition.initialState as () => unknown)()
							: definition.initialState;
					let appliedEvents = 0;
					for (const rawEvent of events) {
						let event = rawEvent;
						if (eventRegistry) {
							if (!eventRegistry.resolve(rawEvent.namespace, rawEvent.eventName)) continue;
							event = eventRegistry.migrate(rawEvent);
						}
						if (event.namespace !== definition.namespace) continue;
						if (definition.eventNames && !definition.eventNames.includes(event.eventName)) continue;
						state = definition.apply(state, structuredClone(event));
						appliedEvents++;
					}
					return {
						namespace: definition.namespace,
						projectionName: definition.projectionName,
						version: definition.version,
						state: structuredClone(state),
						appliedEvents,
					};
				}),
			);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			for (const definition of [...definitions.values()]) {
				definitions.delete(eventKey(definition.namespace, definition.projectionName));
				for (const listener of listeners) listener(definition, false);
			}
		},
	};
}
