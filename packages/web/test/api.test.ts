import { describe, expect, it, vi } from "vitest";
import { callRpc, selectWorkspace } from "../src/api.ts";

describe("workspace-bound RPC requests", () => {
	it("keeps retries on the workspace selected when the request started", async () => {
		vi.useFakeTimers();
		const requests: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			requests.push(String(input));
			if (requests.length === 1)
				return new Response(JSON.stringify({ ok: false, error: { message: "busy" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				});
			return new Response(JSON.stringify({ ok: true, result: { value: "ok" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("window", { location: { origin: "http://localhost" }, setTimeout });
		vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });

		selectWorkspace("workspace-a");
		const pending = callRpc<{ readonly value: string }>("ping");
		selectWorkspace("workspace-b");
		await vi.advanceTimersByTimeAsync(250);
		await expect(pending).resolves.toEqual({ value: "ok" });
		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.includes("workspaceId=workspace-a"))).toBe(true);
		vi.useRealTimers();
	});

	it("coalesces concurrent read RPCs", async () => {
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				new Response(JSON.stringify({ ok: true, result: { value: "ok" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("window", { location: { origin: "http://localhost" }, setTimeout });
		vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });

		selectWorkspace("workspace-a");
		await expect(Promise.all([callRpc("get_settings"), callRpc("get_settings")])).resolves.toEqual([
			{ value: "ok" },
			{ value: "ok" },
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
