import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

interface TrustFile {
	readonly version: 1;
	readonly projects: Record<string, boolean>;
}

function normalize(path: string): string {
	return resolve(path);
}

function emptyTrustFile(): TrustFile {
	return { version: 1, projects: {} };
}

export class ProjectTrustManager {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = resolve(filePath);
	}

	async get(cwd: string): Promise<boolean | null> {
		const data = await this.read();
		let current = normalize(cwd);
		while (true) {
			const decision = data.projects[current];
			if (decision === true || decision === false) return decision;
			const parent = parse(current).root === current ? current : resolve(current, "..");
			if (parent === current) return null;
			current = parent;
		}
	}

	async set(cwd: string, decision: boolean | null): Promise<void> {
		const data = await this.read();
		const key = normalize(cwd);
		if (decision === null) delete data.projects[key];
		else data.projects[key] = decision;
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		await rename(temporaryPath, this.filePath);
	}

	private async read(): Promise<TrustFile> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (!isTrustFile(parsed)) return emptyTrustFile();
			return { version: 1, projects: { ...parsed.projects } };
		} catch {
			return emptyTrustFile();
		}
	}
}

function isTrustFile(value: unknown): value is TrustFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { version?: unknown; projects?: unknown };
	if (candidate.version !== 1 || typeof candidate.projects !== "object" || candidate.projects === null) return false;
	return Object.values(candidate.projects).every((decision) => typeof decision === "boolean");
}
