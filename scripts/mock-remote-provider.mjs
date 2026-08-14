import { createServer } from "node:http";

const port = Number(process.env.MOCK_REMOTE_PORT ?? 8787);
const providerId = "local-openai";
const model = {
	 id: "remote-model",
	 name: "Remote Demo Model",
	 api: "openai-responses",
	 input: ["text"],
	 reasoning: false,
	 contextWindow: 128000,
	 maxOutputTokens: 16384,
	 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function sendJson(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	response.end(body);
}

function sendSse(response, events) {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
	response.end();
}

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
	console.log(`${request.method ?? "?"} ${url.pathname}`);

	if (request.method === "GET" && url.pathname === `/api/models/providers/${providerId}`) {
		sendJson(response, 200, { models: [model] });
		return;
	}

	if (request.method === "POST" && url.pathname === "/v1/responses") {
		sendSse(response, [
			{ type: "response.created", response: { id: "resp_demo" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_demo", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "远程模型加载成功。" },
			{ type: "response.output_text.done", output_index: 0, content_index: 0, text: "远程模型加载成功。" },
			{
				type: "response.content_part.done",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "远程模型加载成功。" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_demo",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "远程模型加载成功。", annotations: [] }],
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		return;
	}

	sendJson(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
	console.log(`Mock remote provider listening at http://127.0.0.1:${port}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
