import { describe, expect, it, vi } from "vitest";
import { createOpenAIImagesProvider, generateOpenAIImages } from "../src/index.ts";

describe("OpenAI Images adapter", () => {
	it("normalizes base64 results and sends the Images API request", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=", revised_prompt: "revised" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const result = await generateOpenAIImages(
			{ model: "gpt-image-1", prompt: "a test", n: 1, size: "1024x1024" },
			{ apiKey: "key", baseUrl: "https://gateway.example/v1", fetch },
		);
		expect(result.images).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
		expect(result.revisedPrompts).toEqual(["revised"]);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://gateway.example/v1/images/generations");
		expect(init.headers).toMatchObject({ authorization: "Bearer key" });
		expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-image-1", prompt: "a test" });
	});

	it("downloads URL results and exposes them as image blocks", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.png" }] }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([137, 80, 78, 71]), {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
			);
		const provider = createOpenAIImagesProvider({ apiKey: "key", model: "third-party-image", fetch });
		await expect(provider.generate({ prompt: "test" })).resolves.toEqual([
			{ type: "image", data: "iVBORw==", mimeType: "image/png" },
		]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects malformed or oversized base64 data", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "bad" }] }), { status: 200 }));
		await expect(generateOpenAIImages({ model: "image", prompt: "test" }, { apiKey: "key", fetch })).rejects.toThrow(
			"invalid base64",
		);
	});
});
