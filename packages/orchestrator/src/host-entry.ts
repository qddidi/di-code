import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";
import { RpcSupervisor, type RpcSupervisorOptions } from "./supervisor.ts";

export interface OrchestratorHost {
	readonly create: (options: RpcSupervisorOptions) => RpcSupervisor;
}

export const orchestratorHostKey = createServiceKey<OrchestratorHost>("orchestrator-host");

/** Composition entry for process supervision. The host communicates only through the public RPC SDK. */
export const orchestratorHost: PluginDefinition = {
	apiVersion: 1,
	name: "orchestrator-host",
	version: "0.1.7",
	apply(context) {
		context.set(orchestratorHostKey, { create: (options) => new RpcSupervisor(options) });
	},
};
