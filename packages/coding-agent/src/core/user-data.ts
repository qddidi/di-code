import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Returns a stable, non-path-revealing directory name for workspace-scoped user data. */
export function workspaceStorageKey(cwd: string): string {
	const normalized = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
	return createHash("sha256").update(normalized).digest("hex");
}
