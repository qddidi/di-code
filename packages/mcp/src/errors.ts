export type McpErrorKind = "connection" | "authentication" | "timeout" | "cancelled" | "protocol" | "tool" | "closed";

/** A classified MCP boundary failure that never embeds raw server stderr or credentials. */
export class McpError extends Error {
	readonly kind: McpErrorKind;
	readonly serverId: string;

	constructor(kind: McpErrorKind, serverId: string, message: string, options?: ErrorOptions) {
		super(`MCP server "${serverId}": ${message}`, options);
		this.name = "McpError";
		this.kind = kind;
		this.serverId = serverId;
	}
}

export function redactMcpDiagnostic(value: unknown): string {
	return String(value)
		.replace(/(authorization|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
		.slice(0, 4 * 1024);
}
