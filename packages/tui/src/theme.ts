/** Presentation-only colors consumed by TUI components. Product state stays outside this package. */
export interface TuiTheme {
	readonly name: "dark" | "light" | string;
	readonly foreground: string;
	readonly muted: string;
	readonly accent: string;
	readonly error: string;
	readonly success: string;
}

export const TUI_THEMES: Readonly<Record<"dark" | "light", TuiTheme>> = {
	dark: {
		name: "dark",
		foreground: "\x1b[37m",
		muted: "\x1b[90m",
		accent: "\x1b[36m",
		error: "\x1b[31m",
		success: "\x1b[32m",
	},
	light: {
		name: "light",
		foreground: "\x1b[30m",
		muted: "\x1b[90m",
		accent: "\x1b[34m",
		error: "\x1b[31m",
		success: "\x1b[32m",
	},
};
