import { describe, expect, it } from "vitest";
import {
	EXTENSION_API_VERSION,
	EXTENSION_DEFAULT_TIMEOUT_MS,
	EXTENSION_MAX_PAYLOAD_BYTES,
	EXTENSION_PROTOCOL_VERSION,
	type ExtensionAPI,
	type ExtensionErrorCode,
	isTaskStateTransitionAllowed,
	type PluginManifestV1,
} from "../src/index.ts";

describe("freedom extension stage 0 contract", () => {
	it("exports one versioned API with explicit resource limits", () => {
		expect(EXTENSION_API_VERSION).toBe(1);
		expect(EXTENSION_PROTOCOL_VERSION).toBe(1);
		expect(EXTENSION_MAX_PAYLOAD_BYTES).toBe(256 * 1024);
		expect(EXTENSION_DEFAULT_TIMEOUT_MS).toBe(30_000);
	});

	it("keeps reconciliation and terminal task transitions deterministic", () => {
		expect(isTaskStateTransitionAllowed("starting", "running")).toBe(true);
		expect(isTaskStateTransitionAllowed("running", "needs_reconciliation")).toBe(true);
		expect(isTaskStateTransitionAllowed("needs_reconciliation", "waiting")).toBe(true);
		expect(isTaskStateTransitionAllowed("needs_reconciliation", "running")).toBe(false);
		expect(isTaskStateTransitionAllowed("completed", "running")).toBe(false);
	});

	it("includes ordinary and advanced unavailable error codes in the public type", () => {
		const unavailable: readonly ExtensionErrorCode[] = [
			"SESSION_UNAVAILABLE",
			"PROVIDER_UNAVAILABLE",
			"JOB_UNAVAILABLE",
			"UI_UNAVAILABLE",
			"NETWORK_UNAVAILABLE",
			"SUBPROCESS_UNAVAILABLE",
		];
		expect(unavailable).toHaveLength(6);
	});

	it("is usable as the default setup(api) entry shape", () => {
		const setup = (api: ExtensionAPI): void => {
			api.registerCommand({ name: "hello", description: "hello", run: async () => ({ version: 1, text: "ok" }) });
		};
		const manifest: PluginManifestV1 = {
			apiVersion: 1,
			id: "example" as PluginManifestV1["id"],
			version: "1.0.0",
			entry: "./dist/index.js",
			packageIntegrity: "sha256-aA==",
			permissions: [],
		};
		expect(typeof setup).toBe("function");
		expect(manifest.packageIntegrity).toMatch(/^sha256-/);
	});
});
