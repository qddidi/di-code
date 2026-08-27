import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServerConfig } from "@di-code/mcp";

const PROJECT_CONFIG_FILE_NAME = ".mcp.json";
const LOCAL_CONFIG_FILE_NAME = join(".di-code", "mcp.local.json");
const USER_CONFIG_FILE_NAME = join(".di-code", "mcp.json");
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export type McpConfigScope = "local" | "project" | "user";
type Environment = Readonly<Record<string, string | undefined>>;
export interface McpConfigDocument {
	readonly mcpServers: Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path} must be a non-empty string`);
	return value.trim();
}

function optionalTimeout(value: unknown, path: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 300_000)
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path} must be a positive integer no greater than 300000`);
	return value as number;
}

function resolveEnvironmentValue(value: string, path: string, environment: Environment): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
		const resolved = environment[name];
		if (!resolved) throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path} environment variable "${name}" is not set`);
		return resolved;
	});
}

function parseEnvironment(value: unknown, path: string, environment: Environment): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path} must be an object`);
	const result: Record<string, string> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
			throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path}.${name} is not a valid environment variable name`);
		result[name] = resolveEnvironmentValue(requiredString(raw, `${path}.${name}`), `${path}.${name}`, environment);
	}
	return result;
}

function parseHeaders(value: unknown, path: string, environment: Environment): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path} must be an object`);
	const result: Record<string, string> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!name.trim()) throw new Error(`${PROJECT_CONFIG_FILE_NAME}: ${path} contains an empty header name`);
		result[name] = resolveEnvironmentValue(requiredString(raw, `${path}.${name}`), `${path}.${name}`, environment);
	}
	return result;
}

function inheritedEnvironment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function parseServer(id: string, value: unknown, cwd: string, environment: Environment): McpServerConfig {
	if (!SERVER_ID_PATTERN.test(id))
		throw new Error(
			`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id} must use lowercase letters, numbers, hyphens, or underscores`,
		);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id} must be an object`);
	const entry = value as Record<string, unknown>;
	if (entry.type === undefined || entry.type === "stdio") {
		if (
			entry.args !== undefined &&
			(!Array.isArray(entry.args) || entry.args.some((argument) => typeof argument !== "string"))
		)
			throw new Error(`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id}.args must be an array of strings`);
		const env = parseEnvironment(entry.env, `mcpServers.${id}.env`, environment);
		return {
			id,
			transport: {
				type: "stdio",
				command: requiredString(entry.command, `mcpServers.${id}.command`),
				...(entry.args === undefined ? {} : { args: [...(entry.args as string[])] }),
				cwd,
				env: { ...inheritedEnvironment(), ...env },
			},
			...(optionalTimeout(entry.connectTimeoutMs, `mcpServers.${id}.connectTimeoutMs`) === undefined
				? {}
				: { connectTimeoutMs: optionalTimeout(entry.connectTimeoutMs, `mcpServers.${id}.connectTimeoutMs`) }),
			...(optionalTimeout(entry.callTimeoutMs, `mcpServers.${id}.callTimeoutMs`) === undefined
				? {}
				: { callTimeoutMs: optionalTimeout(entry.callTimeoutMs, `mcpServers.${id}.callTimeoutMs`) }),
		};
	}
	if (entry.type !== "http")
		throw new Error(
			`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id}.type "${String(entry.type)}" is not supported; expected stdio or http`,
		);
	const url = requiredString(entry.url, `mcpServers.${id}.url`);
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch (cause) {
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id}.url must be an absolute http or https URL`, {
			cause,
		});
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id}.url must use http or https`);
	if (parsedUrl.username || parsedUrl.password)
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: mcpServers.${id}.url must not contain credentials`);
	const headers = parseHeaders(entry.headers, `mcpServers.${id}.headers`, environment);
	return {
		id,
		transport: {
			type: "streamable-http" as const,
			url: parsedUrl.toString(),
			...(headers ? { headers } : {}),
		},
		...(optionalTimeout(entry.connectTimeoutMs, `mcpServers.${id}.connectTimeoutMs`) === undefined
			? {}
			: { connectTimeoutMs: optionalTimeout(entry.connectTimeoutMs, `mcpServers.${id}.connectTimeoutMs`) }),
		...(optionalTimeout(entry.callTimeoutMs, `mcpServers.${id}.callTimeoutMs`) === undefined
			? {}
			: { callTimeoutMs: optionalTimeout(entry.callTimeoutMs, `mcpServers.${id}.callTimeoutMs`) }),
	};
}

export function mcpConfigPath(cwd: string, scope: McpConfigScope = "project", homeDirectory = homedir()): string {
	return scope === "project"
		? join(resolve(cwd), PROJECT_CONFIG_FILE_NAME)
		: scope === "local"
			? join(resolve(cwd), LOCAL_CONFIG_FILE_NAME)
			: join(resolve(homeDirectory), USER_CONFIG_FILE_NAME);
}

async function readDocument(path: string): Promise<McpConfigDocument> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return { mcpServers: {} };
		throw cause;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: invalid JSON`, { cause });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: root value must be an object`);
	const servers = (parsed as Record<string, unknown>).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers))
		throw new Error(`${PROJECT_CONFIG_FILE_NAME}: mcpServers must be an object`);
	return { mcpServers: { ...(servers as Record<string, unknown>) } };
}

export async function readMcpConfigScope(
	cwd: string,
	scope: McpConfigScope,
	homeDirectory = homedir(),
): Promise<McpConfigDocument> {
	return readDocument(mcpConfigPath(cwd, scope, homeDirectory));
}

export async function loadMcpConfig(
	cwd: string,
	environment: Environment = process.env,
): Promise<readonly McpServerConfig[]> {
	const document = await readMcpConfigScope(cwd, "project");
	return Object.entries(document.mcpServers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, server]) => parseServer(id, server, cwd, environment));
}

export async function loadEffectiveMcpConfig(options: {
	cwd: string;
	homeDirectory?: string;
	environment?: Environment;
	projectTrusted: boolean;
}): Promise<readonly McpServerConfig[]> {
	const environment = options.environment ?? process.env;
	const scopes: readonly McpConfigScope[] = options.projectTrusted ? ["user", "project", "local"] : ["user"];
	const merged = new Map<string, unknown>();
	for (const scope of scopes) {
		const document = await readMcpConfigScope(options.cwd, scope, options.homeDirectory);
		for (const [id, server] of Object.entries(document.mcpServers)) merged.set(id, server);
	}
	return [...merged.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, server]) => parseServer(id, server, options.cwd, environment));
}

function redactedEntry(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const entry = { ...(value as Record<string, unknown>) };
	for (const field of ["env", "headers"]) {
		const values = entry[field];
		if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
		entry[field] = Object.fromEntries(
			Object.entries(values).map(([name, raw]) => [
				name,
				typeof raw === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw) ? raw : "[redacted]",
			]),
		);
	}
	return entry;
}

export async function listMcpConfig(
	cwd: string,
	scope: McpConfigScope,
	homeDirectory = homedir(),
): Promise<readonly { id: string; scope: McpConfigScope; config: unknown }[]> {
	const document = await readMcpConfigScope(cwd, scope, homeDirectory);
	return Object.entries(document.mcpServers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, config]) => ({ id, scope, config: redactedEntry(config) }));
}

export async function getMcpConfig(
	cwd: string,
	id: string,
	scope?: McpConfigScope,
	homeDirectory = homedir(),
): Promise<{ id: string; scope: McpConfigScope; config: unknown } | undefined> {
	const scopes = scope ? [scope] : (["local", "project", "user"] as const);
	for (const current of scopes) {
		const document = await readMcpConfigScope(cwd, current, homeDirectory);
		if (id in document.mcpServers) return { id, scope: current, config: redactedEntry(document.mcpServers[id]) };
	}
	return undefined;
}

async function writeDocument(
	cwd: string,
	scope: McpConfigScope,
	document: McpConfigDocument,
	homeDirectory = homedir(),
): Promise<void> {
	const path = mcpConfigPath(cwd, scope, homeDirectory);
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify({ mcpServers: document.mcpServers }, null, 2)}\n`, "utf8");
	try {
		await rename(temporaryPath, path);
	} catch (cause) {
		await unlink(temporaryPath).catch(() => undefined);
		throw cause;
	}
}

export async function addMcpConfig(
	cwd: string,
	scope: McpConfigScope,
	id: string,
	config: unknown,
	options: { homeDirectory?: string; environment?: Environment } = {},
): Promise<void> {
	if (!SERVER_ID_PATTERN.test(id)) throw new Error(`Invalid MCP server id "${id}".`);
	const document = await readMcpConfigScope(cwd, scope, options.homeDirectory);
	if (id in document.mcpServers) throw new Error(`MCP server "${id}" already exists in ${scope} scope.`);
	parseServer(id, config, cwd, options.environment ?? process.env);
	await writeDocument(cwd, scope, { mcpServers: { ...document.mcpServers, [id]: config } }, options.homeDirectory);
}

export async function removeMcpConfig(
	cwd: string,
	scope: McpConfigScope,
	id: string,
	homeDirectory = homedir(),
): Promise<void> {
	const document = await readMcpConfigScope(cwd, scope, homeDirectory);
	if (!(id in document.mcpServers)) throw new Error(`MCP server "${id}" was not found in ${scope} scope.`);
	const { [id]: _removed, ...remaining } = document.mcpServers;
	await writeDocument(cwd, scope, { mcpServers: remaining }, homeDirectory);
}

export { SERVER_ID_PATTERN };
