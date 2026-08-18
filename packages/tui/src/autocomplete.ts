import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fuzzyFilter } from "./fuzzy.ts";

export interface AutocompleteItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface AutocompleteSuggestions {
	readonly items: readonly AutocompleteItem[];
	readonly prefix: string;
}

export interface AutocompleteContext {
	readonly text: string;
	readonly cursor: number;
}

export interface AutocompleteProvider {
	getSuggestions(
		context: AutocompleteContext,
		options: { readonly signal: AbortSignal; readonly force?: boolean },
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		context: AutocompleteContext,
		item: AutocompleteItem,
		prefix: string,
	): { text: string; cursor: number };
}

export interface SlashCommand {
	readonly name: string;
	readonly description?: string;
}

function tokenBeforeCursor(text: string, cursor: number): string {
	const beforeCursor = text.slice(0, cursor);
	const delimiters = [...beforeCursor.matchAll(/\s/g)].map((match) => (match.index ?? -1) + match[0].length);
	const delimiter = Math.max(0, ...delimiters);
	return beforeCursor.slice(delimiter);
}

function isWithinRoot(rootDirectory: string, candidate: string): boolean {
	const fromRoot = relative(rootDirectory, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private readonly commands: SlashCommand[];
	private readonly rootDirectory: string;

	constructor(commands: readonly SlashCommand[] = [], rootDirectory: string) {
		this.commands = [...commands];
		const resolvedRoot = resolve(rootDirectory);
		try {
			this.rootDirectory = realpathSync(resolvedRoot);
		} catch {
			this.rootDirectory = resolvedRoot;
		}
	}

	async getSuggestions(
		context: AutocompleteContext,
		options: { readonly signal: AbortSignal; readonly force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		if (options.signal.aborted) return null;
		const token = tokenBeforeCursor(context.text, context.cursor);
		if (token.startsWith("/") && !token.slice(1).includes("/")) {
			const query = token.slice(1);
			const items = fuzzyFilter(this.commands, query, (command) => `${command.name} ${command.description ?? ""}`).map(
				(command) => ({
					value: command.name,
					label: command.name,
					...(command.description ? { description: command.description } : {}),
				}),
			);
			return items.length > 0 ? { items, prefix: token } : null;
		}
		if (!token.startsWith("@")) return null;

		const raw = token.slice(1).replace(/\\/g, "/");
		const slash = raw.lastIndexOf("/");
		const directoryPrefix = slash >= 0 ? raw.slice(0, slash + 1) : "";
		const query = slash >= 0 ? raw.slice(slash + 1) : raw;
		const directory = resolve(this.rootDirectory, directoryPrefix || ".");
		if (!isWithinRoot(this.rootDirectory, directory) || options.signal.aborted) return null;
		let directoryToRead = directory;
		try {
			directoryToRead = realpathSync(directory);
		} catch {
			return null;
		}
		if (!isWithinRoot(this.rootDirectory, directoryToRead) || options.signal.aborted) return null;

		let entries: Dirent<string>[];
		try {
			entries = readdirSync(directoryToRead, { withFileTypes: true });
		} catch {
			return null;
		}
		if (options.signal.aborted) return null;
		const candidates = entries.map((entry) => {
			const isDirectory = entry.isDirectory();
			const display = `@${directoryPrefix}${entry.name}${isDirectory ? "/" : ""}`;
			return { value: display, label: `${entry.name}${isDirectory ? "/" : ""}`, isDirectory };
		});
		const filtered = fuzzyFilter(candidates, query, (candidate) => candidate.label)
			.sort(
				(left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.label.localeCompare(right.label),
			)
			.map(({ value, label }) => ({ value, label }));
		return filtered.length > 0 ? { items: filtered, prefix: token } : null;
	}

	applyCompletion(
		context: AutocompleteContext,
		item: AutocompleteItem,
		prefix: string,
	): { text: string; cursor: number } {
		const start = context.cursor - prefix.length;
		const before = context.text.slice(0, start);
		const after = context.text.slice(context.cursor);
		if (prefix.startsWith("/")) {
			const text = `${before}/${item.value} ${after}`;
			return { text, cursor: before.length + item.value.length + 2 };
		}
		const directory = item.value.endsWith("/");
		const suffix = directory ? "" : " ";
		const text = `${before}${item.value}${suffix}${after}`;
		return { text, cursor: before.length + item.value.length + suffix.length };
	}
}
