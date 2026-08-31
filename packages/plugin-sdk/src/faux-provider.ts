import type { ProviderEvent, ProviderRegistration } from "./freedom-stage0-contracts.ts";

/** Offline provider used by extension conformance tests; it never performs network I/O. */
export function createFauxProvider(
	responses: readonly ProviderEvent[] = [{ type: "completed", stopReason: "stop" }],
): ProviderRegistration {
	return {
		id: "faux",
		models: ["faux"],
		request: async function* (_input, options) {
			for (const response of responses) {
				if (options.signal?.aborted) return;
				yield response;
			}
		},
	};
}
