import { createServiceKey, type PluginDefinition } from "@di-code/plugin-runtime";
import { RpcClient, type RpcTransport } from "./rpc/client.ts";

export interface RpcClientSdk {
	readonly create: (transport: RpcTransport) => RpcClient;
}

/** Public composition entry for the RPC client SDK; it owns no server or process lifecycle. */
export const apiVersion = 1 as const;
export const name = "rpc-client-sdk";
export const version = "0.1.7";
export const rpcClientSdkKey = createServiceKey<RpcClientSdk>("rpc-client-sdk");
export const apply: PluginDefinition["apply"] = (context) => {
	context.set(rpcClientSdkKey, { create: (transport: RpcTransport) => new RpcClient(transport) });
};
