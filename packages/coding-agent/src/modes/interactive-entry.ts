import type { CommandRegistry, InteractiveContextService } from "@di-code/builtins";
import { ProcessTerminal, TUI } from "@di-code/tui";
import type { Locale } from "../i18n.ts";
import type { InteractiveProviderOnboardingOptions } from "../provider-onboarding.ts";
import { InteractiveMode, type InteractiveSessionHandle } from "./interactive.ts";

export interface InteractiveModeEntryOptions {
	readonly session: InteractiveSessionHandle;
	readonly agentDir: string;
	readonly locale: Locale;
	readonly commandRegistry: CommandRegistry;
	readonly context: InteractiveContextService;
	readonly onExit: () => void;
	readonly providerOnboarding?: Omit<InteractiveProviderOnboardingOptions, "tui">;
	readonly initialPrompt: string;
	readonly onCreated?: (mode: InteractiveMode) => void;
}

/** Product mode entry owns terminal construction; the CLI only selects this registered mode. */
export function runInteractiveMode(options: InteractiveModeEntryOptions): number {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const mode = new InteractiveMode({
		session: options.session,
		tui,
		agentDir: options.agentDir,
		locale: options.locale,
		commandRegistry: options.commandRegistry,
		context: options.context,
		onExit: options.onExit,
		...(options.providerOnboarding ? { providerOnboarding: options.providerOnboarding } : {}),
	});
	options.onCreated?.(mode);
	mode.start(options.initialPrompt);
	return 0;
}
