import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readPackagePluginManifest, readPluginManifest } from "./manifest.ts";
import type { ManagedPlugin, PluginRegistry } from "./types.ts";

export interface PluginManagerOptions {
	readonly agentDir: string;
	readonly now?: () => Date;
}

function emptyRegistry(): PluginRegistry {
	return { version: 1, plugins: {} };
}
function isRegistry(value: unknown): value is PluginRegistry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { version?: unknown; plugins?: unknown };
	return candidate.version === 1 && typeof candidate.plugins === "object" && candidate.plugins !== null;
}
function assertManagedPath(target: string, root: string): void {
	const child = relative(resolve(root), resolve(target));
	if (!child || child.startsWith("..") || isAbsolute(child))
		throw new Error("plugin path is outside the managed install directory");
}

export class PluginManager {
	private readonly registryPath: string;
	private readonly installRoot: string;
	private readonly now: () => Date;
	constructor(options: PluginManagerOptions) {
		this.registryPath = resolve(options.agentDir, "plugins", "registry.json");
		this.installRoot = resolve(options.agentDir, "plugins", "installed");
		this.now = options.now ?? (() => new Date());
	}
	async list(): Promise<readonly ManagedPlugin[]> {
		return Object.values((await this.readRegistry()).plugins).sort((a, b) => a.id.localeCompare(b.id));
	}
	async enable(id: string): Promise<ManagedPlugin> {
		return this.setEnabled(id, true);
	}
	async disable(id: string): Promise<ManagedPlugin> {
		return this.setEnabled(id, false);
	}
	async remove(id: string): Promise<void> {
		const registry = await this.readRegistry();
		const plugin = registry.plugins[id];
		if (!plugin) throw new Error(`Unknown plugin: ${id}`);
		assertManagedPath(plugin.installedPath, this.installRoot);
		await rm(plugin.installedPath, { recursive: true, force: true });
		delete registry.plugins[id];
		await this.writeRegistry(registry);
	}
	async installLocal(sourcePath: string): Promise<ManagedPlugin> {
		const source = resolve(sourcePath);
		const manifest = await readPluginManifest(join(source, "plugin.json")).catch(() =>
			readPackagePluginManifest(source),
		);
		const destination = resolve(this.installRoot, manifest.id);
		assertManagedPath(destination, this.installRoot);
		await mkdir(this.installRoot, { recursive: true });
		await rm(destination, { recursive: true, force: true });
		await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
		const plugin: ManagedPlugin = {
			id: manifest.id,
			source,
			installedPath: destination,
			enabled: true,
			installedAt: this.now().toISOString(),
			manifest,
		};
		const registry = await this.readRegistry();
		registry.plugins[plugin.id] = plugin;
		await this.writeRegistry(registry);
		return plugin;
	}
	async install(source: string): Promise<ManagedPlugin> {
		if (!source.startsWith("npm:") && !source.startsWith("git:")) return this.installLocal(source);
		const staging = resolve(this.installRoot, `.staging-${process.pid}-${Date.now()}`);
		await mkdir(staging, { recursive: true });
		try {
			if (source.startsWith("npm:")) {
				await runCommand(
					"npm",
					["install", "--ignore-scripts", "--prefix", staging, source.slice(4)],
					this.installRoot,
				);
				const modules = join(staging, "node_modules");
				const packageName = source.slice(4).replace(/@[^@]+$/, "");
				const sourceRoot = join(modules, packageName);
				return await this.installCopied(sourceRoot, source, staging);
			}
			await rm(staging, { recursive: true, force: true });
			await runCommand("git", ["clone", "--depth", "1", source.slice(4), staging], this.installRoot);
			return await this.installCopied(staging, source, staging);
		} catch (cause) {
			await rm(staging, { recursive: true, force: true });
			throw cause;
		}
	}
	async update(id: string): Promise<ManagedPlugin> {
		const plugin = (await this.readRegistry()).plugins[id];
		if (!plugin) throw new Error(`Unknown plugin: ${id}`);
		const updated = await this.install(plugin.source);
		return plugin.enabled ? updated : this.disable(updated.id);
	}
	private async installCopied(sourceRoot: string, source: string, temporaryRoot: string): Promise<ManagedPlugin> {
		const manifest = await readPluginManifest(join(sourceRoot, "plugin.json")).catch(() =>
			readPackagePluginManifest(sourceRoot),
		);
		const destination = resolve(this.installRoot, manifest.id);
		assertManagedPath(destination, this.installRoot);
		await mkdir(this.installRoot, { recursive: true });
		await rm(destination, { recursive: true, force: true });
		await cp(sourceRoot, destination, { recursive: true, force: false, errorOnExist: false });
		if (resolve(temporaryRoot) !== resolve(sourceRoot)) await rm(temporaryRoot, { recursive: true, force: true });
		const plugin: ManagedPlugin = {
			id: manifest.id,
			source,
			installedPath: destination,
			enabled: true,
			installedAt: this.now().toISOString(),
			manifest,
		};
		const registry = await this.readRegistry();
		registry.plugins[plugin.id] = plugin;
		await this.writeRegistry(registry);
		return plugin;
	}
	private async setEnabled(id: string, enabled: boolean): Promise<ManagedPlugin> {
		const registry = await this.readRegistry();
		const plugin = registry.plugins[id];
		if (!plugin) throw new Error(`Unknown plugin: ${id}`);
		const next = { ...plugin, enabled };
		registry.plugins[id] = next;
		await this.writeRegistry(registry);
		return next;
	}
	private async readRegistry(): Promise<PluginRegistry> {
		try {
			const value: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
			return isRegistry(value) ? { version: 1, plugins: { ...value.plugins } } : emptyRegistry();
		} catch {
			return emptyRegistry();
		}
	}
	private async writeRegistry(registry: PluginRegistry): Promise<void> {
		await mkdir(dirname(this.registryPath), { recursive: true });
		const temporary = `${this.registryPath}.tmp-${process.pid}`;
		await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
		await rename(temporary, this.registryPath);
	}
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
	await new Promise<void>((resolveResult, reject) => {
		const child = spawn(command, [...args], { cwd, stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? resolveResult() : reject(new Error(`${command} plugin install failed`)),
		);
	});
}
