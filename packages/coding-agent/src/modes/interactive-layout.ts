import { type Component, truncateToWidth, visibleWidth } from "@di-code/tui";

export interface InteractiveLayoutOptions {
	readonly header: Component;
	readonly chat: Component;
	readonly composer: Component;
	readonly editor: Component;
	readonly footer: Component;
}

export class InteractiveLayout implements Component {
	private readonly header: Component;
	private readonly chat: Component;
	private readonly composer: Component;
	private readonly editor: Component;
	private readonly footer: Component;
	constructor(options: InteractiveLayoutOptions) {
		this.header = options.header;
		this.chat = options.chat;
		this.composer = options.composer;
		this.editor = options.editor;
		this.footer = options.footer;
	}

	invalidate(): void {
		this.header.invalidate();
		this.chat.invalidate();
		this.composer.invalidate();
		this.editor.invalidate();
		this.footer.invalidate();
	}

	renderTranscript(width: number): string[] {
		return [...this.header.render(width), ...this.chat.render(width), ...this.footer.render(width)];
	}

	render(width: number): string[] {
		return [
			...this.header.render(width),
			...this.chat.render(width),
			...this.composer.render(width),
			...this.renderEditor(width),
			...this.footer.render(width),
		];
	}

	private renderEditor(width: number): string[] {
		if (width <= 0) return [];
		if (width < 3) return this.editor.render(width).map((line) => truncateToWidth(line, width, ""));
		const innerWidth = width - 2;
		const title = " Compose ";
		const top = `┌${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}┐`;
		const content = this.editor.render(innerWidth).map((line) => {
			const clipped = truncateToWidth(line, innerWidth, "", true);
			return `│${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}│`;
		});
		const bottom = `└${"─".repeat(innerWidth)}┘`;
		return [top, ...content, bottom];
	}
}
