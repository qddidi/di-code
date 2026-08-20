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
	private resolveStart?: () => void;

	constructor(options: BuiltinInteractiveFrontendOptions) {
		this.options = options;
	}

	async start(_controller: PluginFrontendController, terminal: PluginTerminalFrontendHost): Promise<void> {
		if (this.mode) throw new Error("Builtin interactive frontend is already started.");
		await new Promise<void>((resolve, reject) => {
			this.resolveStart = resolve;
			const onExit = this.options.onExit;
			this.mode = new InteractiveMode({
				...this.options,
				tui: new TUI(terminal),
				onExit: () => {
					onExit?.();
					this.resolveStart = undefined;
					resolve();
				},
			});
			try {
				this.mode.start(this.options.initialPrompt);
			} catch (cause) {
				this.mode = undefined;
				this.resolveStart = undefined;
				reject(cause);
			}
		});
	}

	async dispose(): Promise<void> {
		this.mode?.stop();
		this.mode = undefined;
		this.resolveStart?.();
		this.resolveStart = undefined;
	}
}

export function createBuiltinInteractiveFrontend(
	options: BuiltinInteractiveFrontendOptions,
): BuiltinInteractiveFrontend {
	return new BuiltinInteractiveFrontend(options);
}
