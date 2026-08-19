import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@di-code/mcp";

const CONFIG_FILE_NAME = ".mcp.json";
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
type Environment = Readonly<Record<string, string | undefined>>;

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${CONFIG_FILE_NAME}: ${path} must be a non-empty string`);
	return value.trim();
}

function resolveEnvironmentValue(value: string, path: string, environment: Environment): string {
	const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
	if (!match) return value;
	const name = match[1];
	const resolved = environment[name];
	if (!resolved) throw new Error(`${CONFIG_FILE_NAME}: ${path} environment variable "${name}" is not set`);
	return resolved;
}

function parseEnvironment(value: unknown, path: string, environment: Environment): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${CONFIG_FILE_NAME}: ${path} must be an object`);
	const result: Record<string, string> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
			throw new Error(`${CONFIG_FILE_NAME}: ${path}.${name} is not a valid environment variable name`);
		result[name] = resolveEnvironmentValue(requiredString(raw, `${path}.${name}`), `${path}.${name}`, environment);
	}
	return result;
}

function parseServer(id: string, value: unknown, cwd: string, environment: Environment): McpServerConfig {
	if (!SERVER_ID_PATTERN.test(id))
		throw new Error(
			`${CONFIG_FILE_NAME}: mcpServers.${id} must use lowercase letters, numbers, hyphens, or underscores`,
		);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${CONFIG_FILE_NAME}: mcpServers.${id} must be an object`);
	const entry = value as Record<string, unknown>;
	if (entry.type !== undefined && entry.type !== "stdio") {
		throw new Error(
			`${CONFIG_FILE_NAME}: mcpServers.${id}.type "${String(entry.type)}" is not supported; only stdio is available`,
		);
	}
	if (
		entry.args !== undefined &&
		(!Array.isArray(entry.args) || entry.args.some((argument) => typeof argument !== "string"))
	) {
		throw new Error(`${CONFIG_FILE_NAME}: mcpServers.${id}.args must be an array of strings`);
	}
	const env = parseEnvironment(entry.env, `mcpServers.${id}.env`, environment);
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return {
		id,
		transport: {
			type: "stdio",
			command: requiredString(entry.command, `mcpServers.${id}.command`),
			...(entry.args === undefined ? {} : { args: [...(entry.args as string[])] }),
			cwd,
			env: { ...inherited, ...env },
		},
	};
}

/** Reads the project-local Claude Code compatible stdio server configuration. */
export async function loadMcpConfig(
	cwd: string,
	environment: Environment = process.env,
): Promise<readonly McpServerConfig[]> {
	const path = resolve(cwd, CONFIG_FILE_NAME);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
		throw cause;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new Error(`${CONFIG_FILE_NAME}: invalid JSON`, { cause });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${CONFIG_FILE_NAME}: root value must be an object`);
	const servers = (parsed as Record<string, unknown>).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers))
		throw new Error(`${CONFIG_FILE_NAME}: mcpServers must be an object`);
	return Object.entries(servers as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, server]) => parseServer(id, server, cwd, environment));
}

export function mcpConfigPath(cwd: string): string {
	return join(resolve(cwd), CONFIG_FILE_NAME);
}
