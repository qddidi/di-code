import { createUiHostEntry, type UiHost } from "@di-code/coding-agent/ui-host";
import { type Terminal, Text, TUI } from "@di-code/tui";

export const fixtureEvents: string[] = [];
export let lastHost: UiHost | undefined;

class FixtureTerminal implements Terminal {
	private started = false;
	private readonly writes: string[] = [];

	start(_onInput: (data: string) => void, _onResize: () => void): void {
		if (this.started) throw new Error("Fixture terminal is already started.");
		this.started = true;
	}

	stop(): void {
		this.started = false;
	}

	write(value: string): void {
		this.writes.push(value);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	moveBy(lines: number): void {
		this.write(`move:${lines}`);
	}

	hideCursor(): void {
		this.write("hide");
	}

	showCursor(): void {
		this.write("show");
	}

	clearLine(): void {
		this.write("clear-line");
	}

	clearFromCursor(): void {
		this.write("clear-from-cursor");
	}

	clearScreen(): void {
		this.write("clear-screen");
	}

	setTitle(title: string): void {
		this.write(title);
	}

	output(): string {
		return this.writes.join("");
	}
}

export const apiVersion = 1 as const;
export const name = "custom-tui-fixture";
const entry = createUiHostEntry(async ({ host }) => {
	fixtureEvents.length = 0;
	lastHost = host;
	const terminal = new FixtureTerminal();
	const tui = new TUI(terminal);
	const status = new Text("custom ui starting");
	tui.addChild(status);
	tui.start();
	try {
		const firstSession = host.session.state().activeSession;
		if (!firstSession) throw new Error("UiHost did not open an initial session.");
		const pending = host.session.prompt({ text: "cancel this", requestId: "custom-cancel" });
		if (!host.session.cancel("custom-cancel")) throw new Error("UiHost did not cancel the active prompt.");
		await pending;
		fixtureEvents.push("cancelled");

		await host.session.retry();
		fixtureEvents.push("retried");

		const nextSession = await host.session.createSession();
		await host.session.openSession(firstSession.id);
		fixtureEvents.push(nextSession.id === firstSession.id ? "invalid-switch" : "switched");

		status.setText("custom ui complete");
		tui.requestRender(true);
		fixtureEvents.push(
			tui.render(terminal.columns).join("\n").includes("custom ui complete") ? "rendered" : "render-failed",
		);
	} finally {
		tui.stop();
		fixtureEvents.push("exited");
	}
});

export const apply = entry.apply;
