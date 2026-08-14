type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type SymbolKey = "-" | "=" | "[" | "]" | "\\" | ";" | "'" | "," | "." | "/" | "`";
type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

export type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type Modifier = "ctrl" | "shift" | "alt" | "super";
type ModifiedKeyId = `${Modifier}+${BaseKey}` | `${Modifier}+${Modifier}+${BaseKey}`;
export type KeyId = BaseKey | ModifiedKeyId;

export const Key = {
	escape: "escape" as const,
	enter: "enter" as const,
	tab: "tab" as const,
	space: "space" as const,
	backspace: "backspace" as const,
	delete: "delete" as const,
	insert: "insert" as const,
	home: "home" as const,
	end: "end" as const,
	pageUp: "pageUp" as const,
	pageDown: "pageDown" as const,
	up: "up" as const,
	down: "down" as const,
	left: "left" as const,
	right: "right" as const,
	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,
	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
} as const;

interface ParsedKey {
	readonly key: string;
	readonly modifiers: ReadonlySet<Modifier>;
}

const LEGACY_SEQUENCES: Readonly<Record<string, BaseKey>> = {
	"\x1b[A": "up",
	"\x1bOA": "up",
	"\x1b[B": "down",
	"\x1bOB": "down",
	"\x1b[C": "right",
	"\x1bOC": "right",
	"\x1b[D": "left",
	"\x1bOD": "left",
	"\x1b[H": "home",
	"\x1bOH": "home",
	"\x1b[1~": "home",
	"\x1b[F": "end",
	"\x1bOF": "end",
	"\x1b[4~": "end",
	"\x1b[2~": "insert",
	"\x1b[3~": "delete",
	"\x1b[5~": "pageUp",
	"\x1b[6~": "pageDown",
	"\x1bOP": "f1",
	"\x1bOQ": "f2",
	"\x1bOR": "f3",
	"\x1bOS": "f4",
	"\x1b[15~": "f5",
	"\x1b[17~": "f6",
	"\x1b[18~": "f7",
	"\x1b[19~": "f8",
	"\x1b[20~": "f9",
	"\x1b[21~": "f10",
	"\x1b[23~": "f11",
	"\x1b[24~": "f12",
};

const CSI_KEYS: Readonly<Record<string, BaseKey>> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
};

function modifiersFromParameter(parameter: number): Set<Modifier> | null {
	if (!Number.isInteger(parameter) || parameter < 1 || parameter > 16) return null;
	const bits = parameter - 1;
	const modifiers = new Set<Modifier>();
	if ((bits & 1) !== 0) modifiers.add("shift");
	if ((bits & 2) !== 0) modifiers.add("alt");
	if ((bits & 4) !== 0) modifiers.add("ctrl");
	if ((bits & 8) !== 0) modifiers.add("super");
	return modifiers;
}

function keyFromCodePoint(codePoint: number, modifiers: Set<Modifier>): string | null {
	switch (codePoint) {
		case 9:
			return "tab";
		case 13:
			return "enter";
		case 27:
			return "escape";
		case 32:
			return "space";
		case 127:
			return "backspace";
	}
	const character = String.fromCodePoint(codePoint);
	if (!/^[A-Za-z0-9\-=[\]\\;',./`]$/.test(character)) return null;
	if (/^[A-Z]$/.test(character)) {
		modifiers.add("shift");
		return character.toLowerCase();
	}
	return character;
}

function parseRawCharacter(data: string): ParsedKey | null {
	if (data === "\r" || data === "\n") return { key: "enter", modifiers: new Set() };
	if (data === "\x1b") return { key: "escape", modifiers: new Set() };
	if (data === "\t") return { key: "tab", modifiers: new Set() };
	if (data === " ") return { key: "space", modifiers: new Set() };
	if (data === "\x7f" || data === "\b") return { key: "backspace", modifiers: new Set() };
	if (data === "\x00") return { key: "space", modifiers: new Set<Modifier>(["ctrl"]) };
	if (data.length !== 1) return null;
	const codePoint = data.codePointAt(0) ?? 0;
	if (codePoint >= 1 && codePoint <= 26) {
		return { key: String.fromCharCode(96 + codePoint), modifiers: new Set<Modifier>(["ctrl"]) };
	}
	if (/^[A-Z]$/.test(data)) {
		return { key: data.toLowerCase(), modifiers: new Set<Modifier>(["shift"]) };
	}
	if (/^[a-z0-9\-=[\]\\;',./`]$/.test(data)) return { key: data, modifiers: new Set() };
	return null;
}

function parseTerminalData(data: string): ParsedKey | null {
	const raw = parseRawCharacter(data);
	if (raw) return raw;

	const legacy = LEGACY_SEQUENCES[data];
	if (legacy) return { key: legacy, modifiers: new Set() };

	const escaped = data.startsWith("\x1b") ? data.slice(1) : "";
	const modifiedCsi = /^\[1;(\d+)([ABCDHF])$/.exec(escaped);
	if (modifiedCsi) {
		const modifiers = modifiersFromParameter(Number(modifiedCsi[1]));
		const key = CSI_KEYS[modifiedCsi[2] ?? ""];
		if (modifiers && key) return { key, modifiers };
	}

	const csiU = /^\[(\d+)(?:;(\d+))?u$/.exec(escaped);
	if (csiU) {
		const modifiers = modifiersFromParameter(Number(csiU[2] ?? 1));
		if (!modifiers) return null;
		const key = keyFromCodePoint(Number(csiU[1]), modifiers);
		if (key) return { key, modifiers };
	}

	const modifyOtherKeys = /^\[27;(\d+);(\d+)~$/.exec(escaped);
	if (modifyOtherKeys) {
		const modifiers = modifiersFromParameter(Number(modifyOtherKeys[1]));
		if (!modifiers) return null;
		const key = keyFromCodePoint(Number(modifyOtherKeys[2]), modifiers);
		if (key) return { key, modifiers };
	}

	if (data.startsWith("\x1b") && Array.from(data).length === 2) {
		const nested = parseRawCharacter(Array.from(data)[1] ?? "");
		if (!nested) return null;
		return { key: nested.key, modifiers: new Set<Modifier>([...nested.modifiers, "alt"]) };
	}
	return null;
}

function parseKeyId(keyId: KeyId): ParsedKey {
	const parts = keyId.split("+");
	const keyPart = parts.pop() ?? "";
	const key = keyPart === "esc" ? "escape" : keyPart === "return" ? "enter" : keyPart;
	return { key, modifiers: new Set(parts as Modifier[]) };
}

export function matchesKey(data: string, keyId: KeyId): boolean {
	const actual = parseTerminalData(data);
	if (!actual) return false;
	const expected = parseKeyId(keyId);
	if (actual.key !== expected.key || actual.modifiers.size !== expected.modifiers.size) return false;
	for (const modifier of actual.modifiers) if (!expected.modifiers.has(modifier)) return false;
	return true;
}
