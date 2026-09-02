import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../src/i18n.tsx";
import { Transcript } from "../src/components/Transcript.tsx";

describe("Transcript assistant images", () => {
	it("renders generated images in the assistant message bubble", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Transcript
					messages={[
						{
							role: "assistant",
							text: "Here is the generated image.",
							images: [{ src: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", alt: "Generated image" }],
						},
					]}
					onRetry={() => undefined}
					canRetry={false}
					onBranch={() => undefined}
				/>
			</I18nProvider>,
		);
		expect(html).toContain('class="message-images"');
		expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
		expect(html).toContain('alt="Generated image"');
	});

	it("shows only dots while waiting for the first response", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Transcript messages={[]} waitingForResponse onRetry={() => undefined} canRetry={false} onBranch={() => undefined} />
			</I18nProvider>,
		);
		expect(html).toContain('class="message message-assistant message-pending"');
		expect(html).toContain('class="streaming-dots"');
		expect(html).not.toContain('class="message-label">di-code</div>');
	});

	it("does not show a second loading indicator once assistant text streams", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Transcript
					messages={[{ role: "assistant", text: "Final summary", status: "streaming" }]}
					waitingForResponse
					onRetry={() => undefined}
					canRetry={false}
					onBranch={() => undefined}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("Final summary");
		expect(html).not.toContain("message-pending");
		expect(html).not.toContain("Preparing response...");
	});
});
