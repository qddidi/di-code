/*
 * Minimal WebUI client. Start `di-code-webui` with DI_CODE_PROVIDER=faux and
 * DI_CODE_WEBUI_PORT=8787, then run this file after `npm run build`.
 */

type RpcResponse =
	| { readonly ok: true; readonly result: Record<string, unknown> }
	| { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const baseUrl = process.env.DI_CODE_WEBUI_URL ?? "http://127.0.0.1:8787";
const token = process.env.DI_CODE_WEBUI_TOKEN;
if (!token || token.length < 32) throw new Error("DI_CODE_WEBUI_TOKEN must contain at least 32 characters.");

class WebUiClient {
	private clientId: string | undefined;
	private sequence = 0;

	get lastSequence(): number {
		return this.sequence;
	}

	private headers(extra: Record<string, string> = {}): Headers {
		const headers = new Headers({ authorization: `Bearer ${token}`, ...extra });
		if (this.clientId) headers.set("x-di-code-client-id", this.clientId);
		return headers;
	}

	async rpc(method: string, params: Record<string, unknown> = {}, id = `${method}-${Date.now()}`): Promise<Record<string, unknown>> {
		const response = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: this.headers({ "content-type": "application/json" }),
			body: JSON.stringify({ version: 1, kind: "request", id, method, params }),
		});
		const responseClientId = response.headers.get("x-di-code-client-id");
		if (responseClientId) this.clientId = responseClientId;
		const value = (await response.json()) as RpcResponse;
		if (!response.ok || !value.ok) {
			const error = value.ok ? { code: String(response.status), message: response.statusText } : value.error;
			throw new Error(`${error.code}: ${error.message}`);
		}
		return value.result;
	}

	async uploadAttachment(): Promise<string> {
		const response = await fetch(`${baseUrl}/attachments`, {
			method: "POST",
			headers: this.headers({ "content-type": "application/json" }),
			body: JSON.stringify({ name: "example.png", contentType: "image/png", data: "iVBORw0KGgo=" }),
		});
		const value = (await response.json()) as RpcResponse;
		if (!response.ok || !value.ok) throw new Error("Attachment upload failed.");
		return String((value.result.attachment as { readonly id: string }).id);
	}

	async events(resumeToken?: string): Promise<{ readonly close: () => void; readonly ready: Promise<string> }> {
		const controller = new AbortController();
		const headers: Record<string, string> = {};
		if (resumeToken) headers["x-di-code-resume-token"] = resumeToken;
		if (this.sequence > 0) headers["last-event-id"] = String(this.sequence);
		const response = await fetch(`${baseUrl}/events`, { headers: this.headers(headers), signal: controller.signal });
		if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`);
		const ready = new Promise<string>((resolveReady, rejectReady) => {
			void (async () => {
				try {
					const reader = response.body?.getReader();
					if (!reader) throw new Error("SSE response has no body.");
					const decoder = new TextDecoder();
					let buffer = "";
					let receivedResumeToken: string | undefined;
					while (!controller.signal.aborted) {
						const chunk = await reader.read();
						if (chunk.done) break;
						buffer += decoder.decode(chunk.value, { stream: true });
						const records = buffer.split("\n\n");
						buffer = records.pop() ?? "";
						for (const record of records) {
							const data = record.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
							if (!data) continue;
							const message = JSON.parse(data) as { readonly resumeToken?: string; readonly sequence?: number; readonly event?: unknown };
							if (message.resumeToken) {
								receivedResumeToken = message.resumeToken;
								console.log("SSE ready; resumeToken received");
								resolveReady(message.resumeToken);
							}
							if (message.sequence !== undefined) this.sequence = Math.max(this.sequence, message.sequence);
							if (message.event) console.log("event", JSON.stringify(message.event));
						}
					}
					if (!receivedResumeToken) rejectReady(new Error("SSE closed before ready."));
				} catch (error) {
					if (!controller.signal.aborted) rejectReady(error);
				}
			})();
		});
		return { close: () => controller.abort(), ready };
	}
}

async function main(): Promise<void> {
	const client = new WebUiClient();
	const stream = await client.events();
	const resumeToken = await stream.ready;

	const capabilities = await client.rpc("get_capabilities", { events: ["sequence", "operation_update", "snapshot_required"] });
	console.log("capabilities", capabilities.events);
	const sessions = await client.rpc("list_sessions");
	console.log("sessions", sessions.sessions);
	console.log("product", await client.rpc("get_product_state"));
	console.log("trust", await client.rpc("get_project_trust"));
	console.log("transcript", await client.rpc("get_transcript"));
	console.log("tree", await client.rpc("get_tree"));

	const attachmentId = await client.uploadAttachment();
	const promptId = "example-prompt";
	const prompt = client.rpc("prompt", { message: "Reply briefly with the current project status.", attachmentIds: [attachmentId] }, promptId);
	await client.rpc("steer", { message: "Use one sentence." }, "example-steer").catch((error) => console.log("steer", error));
	const answer = await prompt;
	console.log("answer", answer.message);
	console.log("operation", await client.rpc("get_operation", { requestId: promptId }));

	// Cancellation is explicit. A fast faux response may finish before this call, in which case `cancelled` is false.
	const cancellable = client.rpc("prompt", { message: "This prompt may be cancelled." }, "example-cancel").catch((error) => console.log("prompt", error));
	console.log("cancel", await client.rpc("cancel", { requestId: "example-cancel" }, "example-cancel-command"));
	await cancellable;
	await client
		.rpc("retry", { targetRequestId: "example-cancel" }, "example-retry")
		.then((result) => console.log("retry", result.message))
		.catch((error) => console.log("retry", error));

	stream.close();
	const reconnected = await client.events(resumeToken);
	await reconnected.ready;
	console.log("reconnected; last sequence", client.lastSequence);
	reconnected.close();
}

await main();
