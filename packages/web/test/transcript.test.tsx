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
});
