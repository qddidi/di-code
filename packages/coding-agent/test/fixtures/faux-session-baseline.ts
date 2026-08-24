import { createFauxProvider, type FauxResponse } from "@di-code/ai";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import type { AgentSessionEvent } from "../test-agent-session.ts";
import { AgentSession } from "../test-agent-session.ts";

export interface FauxSessionBaseline {
	readonly manager: SessionManager;
	readonly session: AgentSession;
	readonly events: AgentSessionEvent[];
}

interface FauxSessionBaselineOptions {
	readonly root: string;
	readonly filePath: string;
	readonly responses: readonly FauxResponse[];
	readonly open?: boolean;
	readonly chunkSize?: number;
}

/**
 * Creates the Stage 0 persistent-session baseline without defining a SessionHost API.
 * Later host tests can reuse this fixture while production ownership remains unchanged.
 */
export async function createFauxSessionBaseline(options: FauxSessionBaselineOptions): Promise<FauxSessionBaseline> {
	const manager = options.open
		? await SessionManager.open(options.filePath)
		: await SessionManager.create({ filePath: options.filePath, cwd: options.root, deferCreate: true });
	const faux = createFauxProvider({
		responses: options.responses,
		...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
	});
	const session = new AgentSession({
		allowedRoot: options.root,
		provider: faux.provider,
		model: faux.model,
		sessionManager: manager,
	});
	const events: AgentSessionEvent[] = [];
	session.subscribeSession((event) => {
		events.push(event);
	});
	return { manager, session, events };
}
