import { describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG_REFRESH_INTERVAL_MS, type ModelCatalogStore, RemoteModelCatalog } from "../src/model-catalog.ts";
import type { Model } from "../src/types.ts";

const baseModel: Model = {
	id: "base",
	name: "Base",
	provider: "anthropic",
	api: "anthropic-messages",
	input: ["text"],
	reasoning: false,
	contextWindow: 1_000,
	maxOutputTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const remoteModel: Model = { ...baseModel, id: "remote", name: "Remote" };

function createStore(initial?: { readonly models: readonly Model[]; readonly checkedAt: number }): ModelCatalogStore & {
	value?: { readonly models: readonly Model[]; readonly checkedAt: number };
} {
	let value = initial;
	return {
		get value() {
			return value;
		},
		async read() {
			return value;
		},
		async write(entry) {
			value = entry;
		},
	};
}

describe("RemoteModelCatalog", () => {
	it("loads, validates, and overlays a remote provider catalog", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ models: [remoteModel] }), { status: 200 }));
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test/root",
			fetch: fetchImpl,
			now: () => 1_000,
		});
		const store = createStore();

		await catalog.refresh({ store, allowNetwork: true });

		expect(catalog.getModels().map((model) => model.id)).toEqual(["base", "remote"]);
		expect(fetchImpl).toHaveBeenCalledWith(
			new URL("https://catalog.test/api/models/providers/anthropic"),
			expect.objectContaining({ headers: { accept: "application/json" } }),
		);
		expect(store.value).toEqual({ models: [remoteModel], checkedAt: 1_000 });
	});

	it("accepts pi.dev model-id keyed catalogs", async () => {
		const keyedModel = { ...remoteModel, provider: undefined };
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ remote: keyedModel }), { status: 200 }),
		);
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: fetchImpl,
		});

		await catalog.refresh({ store: createStore(), allowNetwork: true });

		expect(catalog.getModels().find((model) => model.id === "remote")?.provider).toBe("anthropic");
	});

	it("restores cached models without network access", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: fetchImpl,
		});

		await catalog.refresh({ store: createStore({ models: [remoteModel], checkedAt: 10 }), allowNetwork: false });

		expect(catalog.getModels().map((model) => model.id)).toEqual(["base", "remote"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("skips a fresh cache unless refresh is forced", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const checkedAt = 2_000;
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: fetchImpl,
			now: () => checkedAt + MODEL_CATALOG_REFRESH_INTERVAL_MS - 1,
		});

		await catalog.refresh({ store: createStore({ models: [remoteModel], checkedAt }), allowNetwork: true });

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the cached overlay when refresh fails", async () => {
		const store = createStore({ models: [remoteModel], checkedAt: 0 });
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 })),
			now: () => 1_000,
		});

		await expect(catalog.refresh({ store, allowNetwork: true, force: true })).rejects.toThrow(
			"Model catalog request failed for anthropic: 503",
		);
		expect(catalog.getModels().map((model) => model.id)).toEqual(["base", "remote"]);
		expect(store.value).toEqual({ models: [remoteModel], checkedAt: 1_000 });
	});

	it("rejects invalid remote data without publishing or caching it", async () => {
		const store = createStore({ models: [remoteModel], checkedAt: 0 });
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(JSON.stringify([{ ...remoteModel, api: 123 }]), { status: 200 })),
		});

		await expect(catalog.refresh({ store, allowNetwork: true, force: true })).rejects.toThrow(
			"Invalid model catalog entry",
		);
		expect(catalog.getModels().map((model) => model.id)).toEqual(["base", "remote"]);
		expect(store.value).toEqual({ models: [remoteModel], checkedAt: 0 });
	});

	it("does not request or publish after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn<typeof fetch>();
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: fetchImpl,
		});

		await catalog.refresh({ store: createStore(), allowNetwork: true, signal: controller.signal });

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(catalog.getModels()).toEqual([baseModel]);
	});

	it("coalesces concurrent refreshes into one request", async () => {
		let resolveResponse: ((response: Response) => void) | undefined;
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const catalog = new RemoteModelCatalog("anthropic", [baseModel], {
			baseUrl: "https://catalog.test",
			fetch: fetchImpl,
		});
		const store = createStore();

		const first = catalog.refresh({ store, allowNetwork: true });
		const second = catalog.refresh({ store, allowNetwork: true });
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
		resolveResponse?.(new Response(JSON.stringify([remoteModel]), { status: 200 }));
		await Promise.all([first, second]);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
