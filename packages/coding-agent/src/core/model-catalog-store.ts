import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Model, ModelCatalogEntry, ModelCatalogStore } from "@di-code/ai";

interface PersistedModelCatalog {
	readonly version: 1;
	readonly models: readonly Model[];
	readonly checkedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModel(value: unknown): value is Model {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.provider === "string" &&
		typeof value.api === "string" &&
		Array.isArray(value.input) &&
		value.input.every((item) => item === "text" || item === "image") &&
		typeof value.reasoning === "boolean" &&
		Number.isInteger(value.contextWindow) &&
		Number.isInteger(value.maxOutputTokens) &&
		isRecord(value.cost) &&
		["input", "output", "cacheRead", "cacheWrite"].every((field) => {
			const cost = value.cost as Record<string, unknown>;
			return typeof cost[field] === "number" && Number.isFinite(cost[field] as number);
		})
	);
}

function parsePersisted(path: string, value: unknown): ModelCatalogEntry {
	if (!isRecord(value) || value.version !== 1) {
		throw new Error(`Unsupported model catalog cache version in ${path}`);
	}
	if (
		!Array.isArray(value.models) ||
		!value.models.every(isModel) ||
		typeof value.checkedAt !== "number" ||
		!Number.isFinite(value.checkedAt)
	) {
		throw new Error(`Invalid model catalog cache ${path}`);
	}
	return { models: value.models, checkedAt: value.checkedAt };
}

export class FileModelCatalogStore implements ModelCatalogStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async read(): Promise<ModelCatalogEntry | undefined> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(
				`Unable to read model catalog cache ${this.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
		try {
			return parsePersisted(this.path, JSON.parse(text) as unknown);
		} catch (cause) {
			if (
				cause instanceof Error &&
				(cause.message.startsWith("Invalid model catalog cache") ||
					cause.message.startsWith("Unsupported model catalog cache"))
			)
				throw cause;
			throw new Error(`Invalid model catalog cache ${this.path}: malformed JSON`);
		}
	}

	async write(entry: ModelCatalogEntry): Promise<void> {
		const persisted: PersistedModelCatalog = { version: 1, models: entry.models, checkedAt: entry.checkedAt };
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
	}
}
