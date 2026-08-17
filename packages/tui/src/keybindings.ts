import { Key, type KeyId, matchesKey } from "./keys.ts";

export interface Keybindings {
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.input.submit": true;
	"tui.input.newLine": true;
	"tui.input.cancel": true;
	"tui.input.tab": true;
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
}

export type Keybinding = keyof Keybindings;
export interface KeybindingDefinition {
	readonly defaultKeys: KeyId | readonly KeyId[];
	readonly description: string;
}
export type KeybindingsConfig = Partial<Record<Keybinding, KeyId | readonly KeyId[]>>;
export interface KeybindingConflict {
	readonly key: KeyId;
	readonly keybindings: Keybinding[];
}

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: Key.up, description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: Key.down, description: "Move cursor down" },
	"tui.editor.cursorLeft": { defaultKeys: [Key.left, Key.ctrl("b")], description: "Move cursor left" },
	"tui.editor.cursorRight": { defaultKeys: [Key.right, Key.ctrl("f")], description: "Move cursor right" },
	"tui.editor.cursorLineStart": {
		defaultKeys: [Key.home, Key.ctrl("a")],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": { defaultKeys: [Key.end, Key.ctrl("e")], description: "Move to line end" },
	"tui.editor.deleteCharBackward": { defaultKeys: Key.backspace, description: "Delete backward" },
	"tui.editor.deleteCharForward": {
		defaultKeys: [Key.delete, Key.ctrl("d")],
		description: "Delete forward",
	},
	"tui.editor.deleteToLineStart": { defaultKeys: Key.ctrl("u"), description: "Delete to line start" },
	"tui.input.submit": { defaultKeys: Key.enter, description: "Submit input" },
	"tui.input.newLine": { defaultKeys: Key.shift("enter"), description: "Insert newline" },
	"tui.input.cancel": { defaultKeys: Key.escape, description: "Cancel input" },
	"tui.input.tab": { defaultKeys: Key.tab, description: "Complete input" },
	"tui.select.up": { defaultKeys: Key.up, description: "Move selection up" },
	"tui.select.down": { defaultKeys: Key.down, description: "Move selection down" },
	"tui.select.confirm": { defaultKeys: Key.enter, description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: [Key.escape, Key.ctrl("c")],
		description: "Cancel selection",
	},
} as const satisfies Record<Keybinding, KeybindingDefinition>;

function normalizeKeys(keys: KeyId | readonly KeyId[]): KeyId[] {
	const values = Array.isArray(keys) ? keys : [keys];
	return [...new Set<KeyId>(values)];
}

export class KeybindingsManager {
	private userBindings: KeybindingsConfig;
	private readonly keysById = new Map<Keybinding, KeyId[]>();
	private conflicts: KeybindingConflict[] = [];

	constructor(userBindings: KeybindingsConfig = {}) {
		this.userBindings = userBindings;
		this.rebuild();
	}

	matches(data: string, keybinding: Keybinding): boolean {
		return (this.keysById.get(keybinding) ?? []).some((key) => matchesKey(data, key));
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.keysById.get(keybinding) ?? [])];
	}

	getConflicts(): KeybindingConflict[] {
		return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.userBindings = userBindings;
		this.rebuild();
	}

	private rebuild(): void {
		this.keysById.clear();
		const claims = new Map<KeyId, Keybinding[]>();

		for (const keybinding of Object.keys(TUI_KEYBINDINGS) as Keybinding[]) {
			const configured = Object.hasOwn(this.userBindings, keybinding);
			const source = configured ? (this.userBindings[keybinding] ?? []) : TUI_KEYBINDINGS[keybinding].defaultKeys;
			const keys = normalizeKeys(source);
			this.keysById.set(keybinding, keys);
			if (!configured) continue;
			for (const key of keys) claims.set(key, [...(claims.get(key) ?? []), keybinding]);
		}

		this.conflicts = [...claims]
			.filter(([, keybindings]) => keybindings.length > 1)
			.map(([key, keybindings]) => ({ key, keybindings }));
	}
}
