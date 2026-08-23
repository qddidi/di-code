import type { AgentSessionFactory } from "@di-code/builtins";
import { AgentSession, type AgentSessionOptions } from "../core/session.ts";

/** Installs the product-owned AgentSession implementation behind the composition SessionFactory service. */
export function installAgentSessionFactory(factory: AgentSessionFactory): () => void {
	return factory.register((options) => new AgentSession(options as AgentSessionOptions));
}
