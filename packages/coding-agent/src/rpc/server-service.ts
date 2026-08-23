import { createServiceKey } from "@di-code/plugin-runtime";

/** Composition-owned RPC process service used by the thin RPC bootstrap. */
export interface RpcServerService {
	readonly shutdown: () => Promise<void>;
	readonly finished: () => Promise<void>;
}

export const rpcServerKey = createServiceKey<RpcServerService>("rpc-server");
