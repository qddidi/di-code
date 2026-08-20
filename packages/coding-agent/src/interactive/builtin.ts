import type { PluginFrontendController, PluginTerminalFrontendHost } from "@di-code/plugin-runtime";
import { TUI } from "@di-code/tui";
import { InteractiveMode, type InteractiveModeOptions } from "../modes/interactive.ts";

export interface BuiltinInteractiveFrontendOptions extends Omit<InteractiveModeOptions, "tui"> {
	readonly initialPrompt?: string;
}

/** The default ANSI frontend. It owns only the terminal facade supplied by the host. */
export class BuiltinInteractiveFrontend {
	readonly id = "builtin" as const;
	private readonly options: BuiltinInteractiveFrontendOptions;
	private mode?: InteractiveMode;

	constructor(options: BuiltinInteractiveFrontendOptions) {
		this.options = options;
	}

	start(_controller: PluginFrontendController, terminal: PluginTerminalFrontendHost): void {
		if (this.mode) throw new Error("Builtin interactive frontend is already started.");
		this.mode = new InteractiveMode({ ...this.options, tui: new TUI(terminal) });
		this.mode.start(this.options.initialPrompt);
	}

	dispose(): void {
		this.mode?.stop();
		this.mode = undefined;
	}
}

export function createBuiltinInteractiveFrontend(
	options: BuiltinInteractiveFrontendOptions,
): BuiltinInteractiveFrontend {
	return new BuiltinInteractiveFrontend(options);
}
